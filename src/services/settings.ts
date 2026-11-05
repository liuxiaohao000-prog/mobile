import * as SecureStore from 'expo-secure-store';
import { getMeta, setMeta } from '../storage/database';
import { AI_API_KEY_STORAGE } from '../storage/secureKeys';

const API_KEY_STORAGE = AI_API_KEY_STORAGE;

export type AiSettings = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export async function getAiSettings(): Promise<AiSettings> {
  // Read the encrypted database first. On a fresh reinstall this initializes
  // the database connection and restores SecureStore values before the API key
  // is read here.
  const baseUrl = await getMeta('ai_base_url', 'https://api.openai.com/v1');
  const model = await getMeta('ai_model', 'gpt-4.1-mini');
  return {
    apiKey: (await SecureStore.getItemAsync(API_KEY_STORAGE)) ?? '',
    baseUrl,
    model,
  };
}

export async function saveAiSettings(settings: AiSettings): Promise<void> {
  await SecureStore.setItemAsync(API_KEY_STORAGE, settings.apiKey.trim());
  await setMeta('ai_base_url', settings.baseUrl.trim().replace(/\/+$/, ''));
  await setMeta('ai_model', settings.model.trim());
}

