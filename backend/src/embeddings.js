import { pipeline } from '@xenova/transformers';

let embedder = null;

// Avoid downloading model every time, reuse the instance
async function getEmbedder() {
  if (!embedder) {
    console.log('Loading local embedding model (Xenova/all-MiniLM-L6-v2)...');
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log('Embedding model loaded successfully.');
  }
  return embedder;
}

/**
 * Generates a 384-dimensional vector embedding for a given text.
 * @param {string} text 
 * @returns {Promise<number[]>}
 */
export async function getEmbedding(text) {
  try {
    const extractor = await getEmbedder();
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  } catch (error) {
    console.error('Error generating embedding:', error);
    throw error;
  }
}
