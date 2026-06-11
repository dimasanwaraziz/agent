import { getEmbedding } from './embeddings.js';
import * as db from './db.js';

/**
 * Call the OpenAI-compatible Chat Completion API
 * @param {Array} messages 
 * @param {Object} settings 
 * @returns {Promise<string>}
 */
export async function callLLM(messages, settings) {
  const apiBaseUrl = settings.apiBaseUrl || 'http://localhost:11434/v1';
  const apiKey = settings.apiKey || '';
  const model = settings.model || 'llama3';
  const temperature = parseFloat(settings.temperature ?? 0.7);

  const url = `${apiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
  };
  
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const body = JSON.stringify({
    model,
    messages,
    temperature,
  });

  console.log(`Calling LLM API: ${url} with model ${model}`);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API Error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  if (!data.choices || data.choices.length === 0) {
    throw new Error('LLM API returned an empty choice list');
  }

  return data.choices[0].message.content;
}

/**
 * Extract facts from the conversation turn and store them in vector database
 * @param {string} userMsg 
 * @param {string} assistantMsg 
 * @param {Object} settings 
 */
export async function extractAndStoreMemories(userMsg, assistantMsg, settings) {
  try {
    const memoryPrompt = `You are a memory processor. Analyze the conversation turn below and extract key facts, preferences, plans, or background details about the user or their projects. 
Format the output as a simple bulleted list of facts (one per line). Extract ONLY actual facts that are useful to remember for future conversations. Do not include chat pleasantries or temporary questions.
Example output format:
- User is learning Javascript
- User's cat is named Luna

If there is nothing new or important to remember, output exactly the word 'NONE'.`;

    const messages = [
      { role: 'system', content: memoryPrompt },
      { role: 'user', content: `User: ${userMsg}\nAssistant: ${assistantMsg}` }
    ];

    console.log('Extracting memories from conversation turn...');
    const result = await callLLM(messages, {
      ...settings,
      temperature: 0.1 // low temp for extraction consistency
    });

    if (!result || result.trim().toUpperCase() === 'NONE') {
      console.log('No new memories to extract.');
      return;
    }

    const facts = result
      .split('\n')
      .map(line => line.replace(/^-\s*/, '').trim())
      .filter(line => line.length > 5 && !line.toUpperCase().includes('NONE'));

    for (const fact of facts) {
      console.log(`Embedding memory: "${fact}"`);
      const vector = await getEmbedding(fact);
      
      // Store in pgvector database
      // pgvector requires formatting vector as '[val1,val2,...]' string
      const vectorStr = `[${vector.join(',')}]`;
      await db.query(
        'INSERT INTO memories (content, embedding) VALUES ($1, $2)',
        [fact, vectorStr]
      );
      console.log(`Stored memory in database: "${fact}"`);
    }
  } catch (error) {
    console.error('Failed to extract and store memories:', error);
  }
}
