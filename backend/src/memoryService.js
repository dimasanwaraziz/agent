import { getEmbedding } from './embeddings.js';
import * as db from './db.js';

/**
 * Retrieve relevant memories based on text query.
 * @param {string} text Query text
 * @param {number} limit Max memories to return
 * @param {number} threshold Cosine similarity threshold (0.0 to 1.0)
 * @returns {Promise<string[]>}
 */
export async function retrieveRelevantMemories(text, limit = 5, threshold = 0.4) {
  try {
    const vector = await getEmbedding(text);
    const vectorStr = `[${vector.join(',')}]`;
    
    // In pgvector, <=> operator calculates cosine distance. 
    // Cosine similarity is 1 - Cosine Distance.
    const res = await db.query(
      `SELECT id, content, 1 - (embedding <=> $1::vector) AS similarity 
       FROM memories 
       ORDER BY embedding <=> $1::vector 
       LIMIT $2`,
      [vectorStr, limit]
    );

    // Filter by similarity threshold
    const matchingMemories = res.rows
      .filter(row => parseFloat(row.similarity) >= threshold)
      .map(row => ({
        id: row.id,
        content: row.content,
        similarity: parseFloat(row.similarity)
      }));

    console.log(`Retrieved ${matchingMemories.length} relevant memories for query "${text}"`);
    return matchingMemories;
  } catch (error) {
    console.error('Error retrieving memories:', error);
    return [];
  }
}
