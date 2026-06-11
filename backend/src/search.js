/**
 * Search the web using DuckDuckGo HTML search (no API keys required).
 * @param {string} query 
 * @returns {Promise<Array<{title: string, link: string, snippet: string}>>}
 */
export async function searchWeb(query) {
  try {
    console.log(`Searching the web for: "${query}"`);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo request failed with status ${response.status}`);
    }

    const html = await response.text();
    const results = [];
    
    // DuckDuckGo Lite HTML results are inside elements with result__snippet and result__a
    // We parse it using regex to avoid extra package dependencies (cheerio, etc.)
    // A standard result entry consists of title/link and snippet
    const resultRegex = /<a class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    
    let match;
    let count = 0;
    while ((match = resultRegex.exec(html)) !== null && count < 4) {
      let link = match[1];
      
      // Clean up redirections by DuckDuckGo (e.g. //duckduckgo.com/l/?uddg=https%3A%2F%2F...)
      if (link.startsWith('//')) {
        link = 'https:' + link;
      }
      if (link.includes('uddg=')) {
        try {
          const urlObj = new URL(link);
          const uddg = urlObj.searchParams.get('uddg');
          if (uddg) link = decodeURIComponent(uddg);
        } catch {
          // Fallback if URL parsing fails
        }
      }
      
      const title = match[2].replace(/<[^>]*>/g, '').trim();
      const snippet = match[3].replace(/<[^>]*>/g, '').trim();
      
      if (title && snippet) {
        results.push({ title, link, snippet });
        count++;
      }
    }
    
    console.log(`Found ${results.length} web search results.`);
    return results;
  } catch (error) {
    console.error('Failed to perform web search:', error);
    return [];
  }
}
