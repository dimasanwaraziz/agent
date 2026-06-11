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
    
    // Split the html by "result__body" to isolate each search result element
    const blocks = html.split('result__body');
    
    // The first block is header content, skip it
    for (let i = 1; i < blocks.length && results.length < 5; i++) {
      const block = blocks[i];
      
      // Extract URL and Title from class="result__a"
      const urlMatch = block.match(/href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/) || 
                       block.match(/class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
                       
      // Extract snippet from class="result__snippet"
      const snippetMatch = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/);
      
      if (urlMatch && snippetMatch) {
        let link = urlMatch[1];
        let title = urlMatch[2].replace(/<[^>]*>/g, '').trim();
        let snippet = snippetMatch[1].replace(/<[^>]*>/g, '').trim();
        
        // Skip ad links
        if (link.includes('duckduckgo.com/y.js') || link.includes('ad_domain')) {
          continue;
        }

        // Clean HTML entities
        title = title
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'");

        snippet = snippet
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .replace(/<b>/g, '')
          .replace(/<\/b>/g, '');
        
        if (link.startsWith('//')) {
          link = 'https:' + link;
        }
        
        // Resolve DuckDuckGo redirects to get the clean target URL
        if (link.includes('uddg=')) {
          try {
            const urlObj = new URL(link);
            const uddg = urlObj.searchParams.get('uddg');
            if (uddg) link = decodeURIComponent(uddg);
          } catch {
            // Keep original if decoding fails
          }
        }
        
        results.push({ title, link, snippet });
      }
    }
    
    console.log(`Found ${results.length} web search results (ad filtered).`);
    return results;
  } catch (error) {
    console.error('Failed to perform web search:', error);
    return [];
  }
}
