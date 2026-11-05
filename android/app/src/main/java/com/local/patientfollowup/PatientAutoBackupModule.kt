package com.local.patientfollowup

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.Settings
import android.util.Log
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.uimanager.ViewManager
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import javax.crypto.CipherInputStream
import javax.crypto.CipherOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

private const val AUTO_BACKUP_MAGIC = "YANBAN-AUTO-BACKUP-V1"
private const val STATE_PREFIX = "patient-followup-state-"
private const val ATTACHMENT_PREFIX = "patient-followup-attachment-"
private const val BACKUP_MIME = "application/octet-stream"
private const val EMBEDDED_BACKUP_SECRET = "yanban-local-auto-backup-v1-device-bound-key"
private const val MAX_METADATA_BYTES = 1024 * 1024
private const val AUTO_BACKUP_TAG = "PatientAutoBackup"
private const val BACKUP_PREFS = "patient_auto_backup"
private const val BACKUP_TREE_URI = "backup_tree_uri"
private const val PICK_BACKUP_DIRECTORY_REQUEST = 8417

class PatientAutoBackupPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(PatientAutoBackupModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}

class PatientAutoBackupModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext), ActivityEventListener {
  private var pendingDirectoryPromise: Promise? = null

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun getName(): String = "PatientAutoBackup"

  @ReactMethod
  fun hasBackupAccess(promise: Promise) {
    promise.resolve(getBackupTreeUri() != null)
  }

  @ReactMethod
  fun getBackupDirectoryName(promise: Promise) {
    try {
      val treeUri = getBackupTreeUri()
      promise.resolve(treeUri?.let { treeDisplayPath(it) })
    } catch (error: Throwable) {
      promise.reject("BACKUP_DIRECTORY_NAME_FAILED", error.message ?: "无法读取备份文件夹名称。", error)
    }
  }

  @ReactMethod
  fun selectBackupDirectory(promise: Promise) {
    try {
      val activity = reactContext.currentActivity
        ?: error("无法打开系统文件夹选择器，请稍后重试。")
      if (pendingDirectoryPromise != null) {
        promise.reject("BACKUP_DIRECTORY_PICKER_BUSY", "文件夹选择器已打开。")
        return
      }

      val initialUri = DocumentsContract.buildTreeDocumentUri(
        "com.android.externalstorage.documents",
        "primary:Download/_.yanban-patient-followup",
      )
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
        addFlags(
          Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
            Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          putExtra(DocumentsContract.EXTRA_INITIAL_URI, initialUri)
        }
      }
      pendingDirectoryPromise = promise
      activity.startActivityForResult(intent, PICK_BACKUP_DIRECTORY_REQUEST)
    } catch (error: Throwable) {
      pendingDirectoryPromise = null
      promise.reject("BACKUP_DIRECTORY_PICKER_FAILED", error.message ?: "无法打开系统文件夹选择器。", error)
    }
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != PICK_BACKUP_DIRECTORY_REQUEST) return
    val promise = pendingDirectoryPromise ?: return
    pendingDirectoryPromise = null
    if (resultCode != Activity.RESULT_OK || data?.data == null) {
      promise.resolve(false)
      return
    }

    val treeUri = data.data!!
    val grantFlags = data.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    if ((grantFlags and Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0 ||
      (grantFlags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == 0
    ) {
      promise.reject("BACKUP_DIRECTORY_GRANT_INCOMPLETE", "系统未授予所需的文件夹读写权限。")
      return
    }

    try {
      reactContext.contentResolver.takePersistableUriPermission(treeUri, grantFlags)
      val previousTreeUri = getBackupTreeUri()
      Thread {
        try {
          if (previousTreeUri != null && previousTreeUri != treeUri) {
            copyBackupFiles(previousTreeUri, treeUri)
          }
          backupPreferences().edit().putString(BACKUP_TREE_URI, treeUri.toString()).apply()
          if (previousTreeUri != null && previousTreeUri != treeUri) {
            runCatching {
              reactContext.contentResolver.releasePersistableUriPermission(
                previousTreeUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
              )
            }
          }
          promise.resolve(true)
        } catch (error: Throwable) {
          runCatching { reactContext.contentResolver.releasePersistableUriPermission(treeUri, grantFlags) }
          promise.reject("BACKUP_DIRECTORY_SAVE_FAILED", error.message ?: "无法保存所选文件夹。", error)
        }
      }.start()
    } catch (error: Throwable) {
      promise.reject("BACKUP_DIRECTORY_GRANT_FAILED", error.message ?: "无法保存文件夹访问授权。", error)
    }
  }

  override fun onNewIntent(intent: Intent) = Unit

  @ReactMethod
  fun createAutomaticBackup(
    metadataJson: String,
    databaseUri: String,
    attachmentUris: ReadableArray,
    promise: Promise,
  ) {
    try {
      val treeUri = getBackupTreeUri() ?: error("尚未选择本机自动备份文件夹。")
      Log.i(AUTO_BACKUP_TAG, "Creating automatic recovery point")
      val metadata = JSONObject(metadataJson)
      validateMetadata(metadata)
      val attachmentNames = metadata.getJSONArray("attachments")
      require(attachmentNames.length() == attachmentUris.size()) { "自动备份附件清单不匹配。" }

      val database = localFile(databaseUri)
      require(database.isFile) { "找不到本机数据库文件。" }
      val attachments = mutableListOf<File>()
      for (index in 0 until attachmentUris.size()) {
        val file = localFile(attachmentUris.getString(index) ?: "")
        val expectedName = attachmentNames.getString(index)
        require(file.isFile && file.name == expectedName && isSafeAttachmentName(expectedName)) {
          "自动备份附件无效。"
        }
        attachments.add(file)
      }

      // Attachment blobs are already AES-encrypted by the app. Copy only new
      // blobs; each database checkpoint remains small and is refreshed on edits.
      for (file in attachments) {
        val backupName = ATTACHMENT_PREFIX + file.name
        if (findTreeDocument(treeUri, backupName) == null) {
          writeTreeFile(treeUri, backupName) { output -> file.inputStream().buffered().use { it.copyTo(output) } }
        }
      }

      val stateName = "$STATE_PREFIX${System.currentTimeMillis()}.yfb"
      writeTreeFile(treeUri, stateName) { output ->
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        output.write(AUTO_BACKUP_MAGIC.toByteArray(StandardCharsets.UTF_8))
        output.write(iv)
        val cipher = cipher(Cipher.ENCRYPT_MODE, iv)
        ZipOutputStream(BufferedOutputStream(CipherOutputStream(output, cipher))).use { zip ->
          zip.putNextEntry(ZipEntry("metadata.json"))
          zip.write(metadataJson.toByteArray(StandardCharsets.UTF_8))
          zip.closeEntry()
          zip.putNextEntry(ZipEntry("database.db"))
          database.inputStream().buffered().use { it.copyTo(zip) }
          zip.closeEntry()
        }
      }

      pruneTreeFiles(treeUri, STATE_PREFIX, keep = 1)
      val activeAttachments = (0 until attachmentNames.length())
        .map { ATTACHMENT_PREFIX + attachmentNames.getString(it) }
        .toSet()
      pruneTreeAttachments(treeUri, activeAttachments)
      promise.resolve(stateName)
      Log.i(AUTO_BACKUP_TAG, "Automatic recovery point saved: $stateName")
    } catch (error: Throwable) {
      Log.e(AUTO_BACKUP_TAG, "Automatic recovery point failed", error)
      promise.reject("AUTO_BACKUP_FAILED", error.message ?: "自动备份失败。", error)
    }
  }

  @ReactMethod
  fun restoreAutomaticBackup(promise: Promise) {
    try {
      val treeUri = getBackupTreeUri() ?: error("尚未选择本机自动备份文件夹。")
      Log.i(AUTO_BACKUP_TAG, "Checking automatic recovery point")
      val stateUri = listTreeDocuments(treeUri, STATE_PREFIX).firstOrNull()?.uri
      if (stateUri == null) {
        Log.i(AUTO_BACKUP_TAG, "No automatic recovery point found")
        promise.resolve(null)
        return
      }

      val input = reactContext.contentResolver.openInputStream(stateUri)
        ?: error("无法读取本机自动备份。")
      val magicBytes = AUTO_BACKUP_MAGIC.toByteArray(StandardCharsets.UTF_8)
      val foundMagic = ByteArray(magicBytes.size)
      readFully(input, foundMagic)
      require(foundMagic.contentEquals(magicBytes)) { "自动备份格式无法识别。" }
      val iv = ByteArray(12)
      readFully(input, iv)

      val staging = File(reactContext.cacheDir, "patient-followup-restore-${System.currentTimeMillis()}")
      require(staging.mkdirs()) { "无法准备自动恢复目录。" }
      try {
        var metadataJson: String? = null
        var databaseStaged: File? = null
        ZipInputStream(BufferedInputStream(CipherInputStream(input, cipher(Cipher.DECRYPT_MODE, iv)))).use { zip ->
          val metadataEntry = zip.nextEntry ?: error("自动备份内容为空。")
          require(metadataEntry.name == "metadata.json") { "自动备份清单缺失。" }
          metadataJson = String(readBounded(zip, MAX_METADATA_BYTES), StandardCharsets.UTF_8)
          val metadata = JSONObject(metadataJson!!)
          validateMetadata(metadata)

          val databaseEntry = zip.nextEntry ?: error("自动备份数据库缺失。")
          require(databaseEntry.name == "database.db") { "自动备份数据库无效。" }
          databaseStaged = copyEntry(zip, File(staging, "patient-followup.db"))
          require(zip.nextEntry == null) { "自动备份包含不支持的内容。" }
        }

        val rawMetadata = metadataJson ?: error("自动备份清单缺失。")
        val metadata = JSONObject(rawMetadata)
        require(databaseStaged?.isFile == true && databaseStaged!!.length() >= 100) {
          "自动备份数据库文件无效。"
        }

        val stagedAttachments = mutableListOf<Pair<String, File>>()
        val names = metadata.getJSONArray("attachments")
        for (index in 0 until names.length()) {
          val name = names.getString(index)
          val attachmentUri = findTreeDocument(treeUri, ATTACHMENT_PREFIX + name)?.uri
            ?: error("自动备份附件缺失：$name")
          val staged = File(staging, name)
          val attachmentInput = reactContext.contentResolver.openInputStream(attachmentUri)
            ?: error("无法读取自动备份附件：$name")
          attachmentInput.use { source -> staged.outputStream().buffered().use { source.copyTo(it) } }
          stagedAttachments.add(name to staged)
        }

        val attachmentDirectory = File(reactContext.filesDir, "patient-files")
        require(attachmentDirectory.exists() || attachmentDirectory.mkdirs()) { "无法准备附件恢复目录。" }
        for ((name, staged) in stagedAttachments) moveReplacing(staged, File(attachmentDirectory, name))

        val databaseDirectory = File(reactContext.filesDir, "SQLite")
        require(databaseDirectory.exists() || databaseDirectory.mkdirs()) { "无法准备数据库恢复目录。" }
        moveReplacing(databaseStaged!!, File(databaseDirectory, "patient-followup.db"))
        Log.i(AUTO_BACKUP_TAG, "Automatic recovery point restored")
        promise.resolve(rawMetadata)
      } finally {
        staging.deleteRecursively()
      }
    } catch (error: Throwable) {
      Log.e(AUTO_BACKUP_TAG, "Automatic restore failed", error)
      promise.reject("AUTO_RESTORE_FAILED", error.message ?: "自动恢复失败。", error)
    }
  }

  private fun localFile(uriOrPath: String): File {
    val uri = Uri.parse(uriOrPath)
    return if (uri.scheme == "file") File(uri.path ?: error("文件路径无效。")) else File(uriOrPath)
  }

  private data class TreeDocument(val name: String, val mimeType: String, val modified: Long, val uri: Uri)

  private fun backupPreferences() = reactContext.getSharedPreferences(BACKUP_PREFS, Context.MODE_PRIVATE)

  private fun getBackupTreeUri(): Uri? {
    val raw = backupPreferences().getString(BACKUP_TREE_URI, null) ?: return null
    val uri = Uri.parse(raw)
    val persisted = reactContext.contentResolver.persistedUriPermissions.any {
      it.uri == uri && it.isReadPermission && it.isWritePermission
    }
    if (!persisted || treeDisplayName(uri) == null) return null
    return uri
  }

  // Android's Storage Access Framework returns a document-tree URI, not an
  // unrestricted filesystem path. Render the full human-readable location for
  // the built-in local storage provider; never expose the raw encoded URI.
  private fun treeDisplayPath(treeUri: Uri): String {
    val id = DocumentsContract.getTreeDocumentId(treeUri)
    return when {
      treeUri.authority == "com.android.externalstorage.documents" &&
        id.startsWith("primary:") -> {
        val relative = id.removePrefix("primary:").trim('/')
        if (relative.isBlank()) "手机内部存储" else "手机内部存储/$relative"
      }
      treeUri.authority == "com.android.externalstorage.documents" -> {
        val volume = id.substringBefore(':')
        val relative = id.substringAfter(':', "").trim('/')
        if (relative.isBlank()) "存储设备 $volume" else "存储设备 $volume/$relative"
      }
      else -> (treeDisplayName(treeUri) ?: "已授权文件夹") + "（第三方文件管理器，完整物理路径不可用）"
    }
  }

  private fun treeDisplayName(treeUri: Uri): String? = try {
    val documentId = DocumentsContract.getTreeDocumentId(treeUri)
    val documentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId)
    reactContext.contentResolver.query(
      documentUri,
      arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
      null,
      null,
      null,
    )?.use { cursor ->
      if (cursor.moveToFirst()) cursor.getString(0) else null
    }
  } catch (_: Throwable) {
    null
  }

  private fun listTreeDocuments(treeUri: Uri, prefix: String): List<TreeDocument> {
    val documentId = DocumentsContract.getTreeDocumentId(treeUri)
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, documentId)
    val projection = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED,
    )
    val result = mutableListOf<TreeDocument>()
    reactContext.contentResolver.query(childrenUri, projection, null, null, null)?.use { cursor ->
      val idIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
      val nameIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
      val mimeIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
      val modifiedIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
      while (cursor.moveToNext()) {
        val name = cursor.getString(nameIndex) ?: continue
        val mimeType = cursor.getString(mimeIndex) ?: "application/octet-stream"
        if (name.startsWith(prefix) && mimeType != DocumentsContract.Document.MIME_TYPE_DIR) {
          val uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, cursor.getString(idIndex))
          result.add(TreeDocument(name, mimeType, cursor.getLong(modifiedIndex), uri))
        }
      }
    }
    return result.sortedByDescending { it.modified }
  }

  private fun findTreeDocument(treeUri: Uri, name: String): TreeDocument? {
    val documentId = DocumentsContract.getTreeDocumentId(treeUri)
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, documentId)
    val projection = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED,
    )
    reactContext.contentResolver.query(childrenUri, projection, null, null, null)?.use { cursor ->
      val idIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
      val nameIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
      val mimeIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
      val modifiedIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
      while (cursor.moveToNext()) {
        if (cursor.getString(nameIndex) == name) {
          val mimeType = cursor.getString(mimeIndex) ?: "application/octet-stream"
          return TreeDocument(
            name,
            mimeType,
            cursor.getLong(modifiedIndex),
            DocumentsContract.buildDocumentUriUsingTree(treeUri, cursor.getString(idIndex)),
          )
        }
      }
    }
    return null
  }

  private fun writeTreeFile(treeUri: Uri, displayName: String, write: (java.io.OutputStream) -> Unit) {
    findTreeDocument(treeUri, displayName)?.let { DocumentsContract.deleteDocument(reactContext.contentResolver, it.uri) }
    val rootId = DocumentsContract.getTreeDocumentId(treeUri)
    val rootUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootId)
    val uri = DocumentsContract.createDocument(reactContext.contentResolver, rootUri, BACKUP_MIME, displayName)
      ?: error("Android 未能在所选文件夹创建自动恢复点。")
    try {
      val output = reactContext.contentResolver.openOutputStream(uri, "w")
        ?: error("无法写入所选文件夹中的自动恢复点。")
      output.use(write)
    } catch (error: Throwable) {
      runCatching { DocumentsContract.deleteDocument(reactContext.contentResolver, uri) }
      throw error
    }
  }

  private fun pruneTreeFiles(treeUri: Uri, prefix: String, keep: Int) {
    for (document in listTreeDocuments(treeUri, prefix).drop(keep)) {
      DocumentsContract.deleteDocument(reactContext.contentResolver, document.uri)
    }
  }

  private fun pruneTreeAttachments(treeUri: Uri, activeNames: Set<String>) {
    for (document in listTreeDocuments(treeUri, ATTACHMENT_PREFIX).filter { it.name !in activeNames }) {
      DocumentsContract.deleteDocument(reactContext.contentResolver, document.uri)
    }
  }

  private fun copyBackupFiles(sourceTree: Uri, destinationTree: Uri) {
    val sourceStates = listTreeDocuments(sourceTree, STATE_PREFIX)
    if (sourceStates.isEmpty() || listTreeDocuments(destinationTree, STATE_PREFIX).isNotEmpty()) return
    val sourceFiles = sourceStates + listTreeDocuments(sourceTree, ATTACHMENT_PREFIX)
    for (document in sourceFiles) {
      if (findTreeDocument(destinationTree, document.name) != null) continue
      writeTreeFile(destinationTree, document.name) { output ->
        val input = reactContext.contentResolver.openInputStream(document.uri)
          ?: error("无法复制已有自动备份：${document.name}")
        input.buffered().use { it.copyTo(output) }
      }
    }
  }

  private fun validateMetadata(metadata: JSONObject) {
    require(metadata.optString("applicationId") == "com.local.patientfollowup") {
      "自动备份不属于研伴。"
    }
    require(metadata.optInt("formatVersion") == 1) { "自动备份版本不受支持。" }
    require(metadata.optString("databaseKey").matches(Regex("^[0-9a-fA-F]{64}$"))) {
      "自动备份数据库密钥无效。"
    }
    require(metadata.optString("fileEncryptionKey").matches(Regex("^[0-9a-fA-F]{64}$"))) {
      "自动备份附件密钥无效。"
    }
    require(metadata.has("aiApiKey") && metadata.get("aiApiKey") is String) {
      "自动备份 AI 设置无效。"
    }
    val attachments = metadata.optJSONArray("attachments") ?: error("自动备份附件清单缺失。")
    for (index in 0 until attachments.length()) {
      require(isSafeAttachmentName(attachments.getString(index))) { "自动备份附件名称无效。" }
    }
  }

  private fun isSafeAttachmentName(name: String): Boolean =
    Regex("^[A-Za-z0-9-]+\\.(png|jpg)\\.enc$").matches(name)

  private fun cipher(mode: Int, iv: ByteArray): Cipher {
    val androidId = Settings.Secure.getString(reactContext.contentResolver, Settings.Secure.ANDROID_ID)
      ?: error("无法读取本机加密标识。")
    val salt = "com.local.patientfollowup:$androidId".toByteArray(StandardCharsets.UTF_8)
    val keySpec = PBEKeySpec(EMBEDDED_BACKUP_SECRET.toCharArray(), salt, 250_000, 256)
    val key = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(keySpec).encoded
    keySpec.clearPassword()
    return Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
    }
  }

  private fun readFully(input: InputStream, destination: ByteArray) {
    var offset = 0
    while (offset < destination.size) {
      val count = input.read(destination, offset, destination.size - offset)
      require(count > 0) { "自动备份文件不完整。" }
      offset += count
    }
  }

  private fun readBounded(input: InputStream, limit: Int): ByteArray {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    while (true) {
      val count = input.read(buffer)
      if (count < 0) break
      require(output.size() + count <= limit) { "自动备份清单过大。" }
      output.write(buffer, 0, count)
    }
    return output.toByteArray()
  }

  private fun copyEntry(input: InputStream, destination: File): File {
    destination.outputStream().buffered().use { input.copyTo(it) }
    return destination
  }

  private fun moveReplacing(source: File, destination: File) {
    destination.parentFile?.let { require(it.exists() || it.mkdirs()) { "无法准备恢复目录。" } }
    if (destination.exists()) require(destination.delete()) { "无法替换旧的恢复文件。" }
    require(source.renameTo(destination)) { "无法写入恢复文件。" }
  }
}
