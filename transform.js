const fs = require('fs').promises;
const path = require('path');

const FEED_URL = 'https://www.bisturi.com.br/XMLData/feed-dinamize.xml';
const OUT = 'docs/feed-dinamize.xml';
const LOCAL_FEED = 'feed.xml'; // se workflow salvar com curl
const MAX_RETRIES = 5;
const TIMEOUT_MS = 20000; // 20s por tentativa

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function normalizePriceRaw(raw){
  if(!raw) return raw;
  let s = String(raw).replace(/\s+/g,' ');
  s = s.replace(/[^\d.,]/g,''); // keep digits, dot and comma
  // remove thousands separator dots (only those preceding groups of 3 digits)
  s = s.replace(/\.(?=\d{3}([.,]|$))/g, '');
  s = s.replace(/,/g, '.');      // comma -> dot
  const n = Number(s);
  return isNaN(n) ? s : n.toFixed(2);
}

function transformXml(xml){
  if(!/^\s*<\?xml/i.test(xml)) xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;

  // trim id, mpn, gtin inside CDATA
  xml = xml.replace(/<g:(id|mpn|gtin)>\s*<!\[CDATA\[\s*([\s\S]*?)\s*\]\]>\s*<\/g:\1>/gi,
    (_, tag, inner) => `<g:${tag}><![CDATA[${inner.trim()}]]></g:${tag}>`);

  // normalize <g:price> (with or without CDATA)
  xml = xml.replace(/<g:price>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/g:price>/gi, (_, inner) => {
    const num = (inner.match(/[\d\.,]+/)||[])[0]||'';
    return `<g:price>${normalizePriceRaw(num)} BRL</g:price>`;
  });
  xml = xml.replace(/<g:price>\s*([^<]+?)\s*<\/g:price>/gi, (_, inner) => {
    const num = (inner.match(/[\d\.,]+/)||[])[0]||'';
    return `<g:price>${normalizePriceRaw(num)} BRL</g:price>`;
  });

  // normalize g:amount inside installment
  xml = xml.replace(/<g:amount>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/g:amount>/gi, (_, inner) => {
    const num = (inner.match(/[\d\.,]+/)||[])[0]||'';
    return `<g:amount>${normalizePriceRaw(num)} BRL</g:amount>`;
  });
  xml = xml.replace(/<g:amount>\s*([^<]+?)\s*<\/g:amount>/gi, (_, inner) => {
    const num = (inner.match(/[\d\.,]+/)||[])[0]||'';
    return `<g:amount>${normalizePriceRaw(num)} BRL</g:amount>`;
  });

  // availability PT -> EN
  xml = xml.replace(/<g:availability>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/g:availability>/gi, (_, inner) => {
    const val = inner.trim().toLowerCase();
    if(/disp|dispon|available|in stock/i.test(val)) return `<g:availability><![CDATA[in stock]]></g:availability>`;
    if(/esgot|indispon|out of stock|unavailable/i.test(val)) return `<g:availability><![CDATA[out of stock]]></g:availability>`;
    return `<g:availability><![CDATA[in stock]]></g:availability>`;
  });
  xml = xml.replace(/<g:availability>\s*([^<]+?)\s*<\/g:availability>/gi, (_, inner) => {
    const val = inner.trim().toLowerCase();
    if(/disp|dispon|available|in stock/i.test(val)) return `<g:availability><![CDATA[in stock]]></g:availability>`;
    if(/esgot|indispon|out of stock|unavailable/i.test(val)) return `<g:availability><![CDATA[out of stock]]></g:availability>`;
    return `<g:availability><![CDATA[in stock]]></g:availability>`;
  });

  // avoid self-closed image tag -> normalize to open/close empty
  xml = xml.replace(/<g:image_link\s*\/>/gi, '<g:image_link></g:image_link>');

  // encapsula channel se faltar
  if(!/<channel[\s>]/i.test(xml)){
    const items = Array.from(xml.matchAll(/<item[\s\S]*?<\/item>/gi)).map(m => m[0]).join('\n');
    const rssOpen = (xml.match(/<rss[^>]*>/i)||[])[0] || '<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">';
    const decl = (xml.match(/<\?xml[^>]*\?>/i)||[])[0] || '<?xml version="1.0" encoding="UTF-8"?>';
    xml = `${decl}\n${rssOpen}\n<channel>\n<title>Bisturi Material Hospitalar</title>\n<link>https://www.bisturi.com.br</link>\n<description>Feed normalizado</description>\n${items}\n</channel>\n</rss>`;
  }

  return xml;
}

// ensureImageLinks: if g:image_link empty, try to extract first img src from description
function ensureImageLinks(xml, fallback = 'https://www.bisturi.com.br/images/placeholder.jpg'){
  return xml.replace(/<item[\s\S]*?<\/item>/gi, (itemBlock) => {
    // If already has non-empty g:image_link (with or without CDATA), keep it
    const hasImageUrl = /<g:image_link>\s*(?:<!\[CDATA\[)?\s*(https?:\/\/[^<\]\s]+)\s*(?:\]\]>)?\s*<\/g:image_link>/i.test(itemBlock);
    if(hasImageUrl) {
      // but remove CDATA for g:image_link specifically (normalize to plain URL)
      itemBlock = itemBlock.replace(/<g:image_link>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/g:image_link>/gi, '<g:image_link>$1</g:image_link>');
      return itemBlock;
    }

    // No valid g:image_link present -> try to find <img src="..."> inside the item (usually in description)
    const imgMatch = itemBlock.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
    let imgUrl = imgMatch ? imgMatch[1].trim() : null;

    // If found relative path, make absolute
    if(imgUrl && imgUrl.startsWith('/')) imgUrl = 'https://www.bisturi.com.br' + imgUrl;

    // If still not found, try to scrape any image URL present in the item block
    if(!imgUrl){
      const anyUrl = itemBlock.match(/https?:\/\/[^<>\s'"]+\.(?:jpg|jpeg|png|webp|gif)/i);
      if(anyUrl) imgUrl = anyUrl[0];
    }

    if(!imgUrl) imgUrl = fallback;

    // Insert plain url into g:image_link tags (avoid CDATA)
    if(/<g:image_link\s*\/>/i.test(itemBlock)){
      itemBlock = itemBlock.replace(/<g:image_link\s*\/>/i, `<g:image_link>${imgUrl}</g:image_link>`);
    } else if(/<g:image_link>\s*<\/g:image_link>/i.test(itemBlock)){
      itemBlock = itemBlock.replace(/<g:image_link>\s*<\/g:image_link>/i, `<g:image_link>${imgUrl}</g:image_link>`);
    } else if(!/<g:image_link[^>]*>/i.test(itemBlock)){
      // if tag doesn't exist, insert before </item>
      itemBlock = itemBlock.replace(/<\/item>/i, `  <g:image_link>${imgUrl}</g:image_link>\n</item>`);
    } else {
      // as fallback, replace any CDATA wrapped version
      itemBlock = itemBlock.replace(/<g:image_link>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/g:image_link>/gi, `<g:image_link>$1</g:image_link>`);
    }

    return itemBlock;
  });
}

async function fetchWithRetry(url){
  // if local feed file exists (downloaded by curl step), use it
  try {
    const stat = await fs.stat(LOCAL_FEED);
    if(stat && stat.isFile()){
      console.log('Using local feed file', LOCAL_FEED);
      return await fs.readFile(LOCAL_FEED, 'utf8');
    }
  } catch(e){ /* ignore - file not present */ }

  for(let attempt=1; attempt<=MAX_RETRIES; attempt++){
    console.log(`Attempt ${attempt}/${MAX_RETRIES} - fetch ${url}`);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/115 Safari/537.36',
          'Accept': 'application/xml, text/xml, */*'
        },
        signal: controller.signal
      });
      clearTimeout(timeout);

      console.log('Remote status:', res.status);
      if(!res.ok){
        const bodySnippet = await res.text().then(t => t.slice(0,1000)).catch(()=>'<no body>');
        console.log('Error response snippet:', bodySnippet);
        throw new Error('Fetch returned status ' + res.status);
      }
      const text = await res.text();
      return text;
    } catch(err){
      console.log('Fetch error:', err.message || err.toString());
      if(attempt < MAX_RETRIES){
        const wait = 1000 * Math.pow(2, attempt);
        console.log(`Waiting ${wait}ms before next attempt...`);
        await sleep(wait);
      } else {
        throw new Error('Failed to fetch feed after ' + MAX_RETRIES + ' attempts: ' + err.message);
      }
    }
  }
}

(async () => {
  try {
    console.log('Fetching feed (local fallback or remote)...');
    const xmlRaw = await fetchWithRetry(FEED_URL);
    console.log('Transforming XML...');
    let out = transformXml(xmlRaw);

    // Ensure image links exist and remove CDATA for g:image_link (normalize)
    out = ensureImageLinks(out);

    // OPTIONAL: if you want to also strip CDATA from any remaining g:image_link that slipped through
    out = out.replace(/<g:image_link>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/g:image_link>/gi, '<g:image_link>$1</g:image_link>');

    // write output
    await fs.mkdir(path.dirname(OUT), { recursive: true });
    await fs.writeFile(OUT, out, 'utf8');
    console.log('Wrote', OUT);
  } catch(err){
    console.error('Error:', err);
    process.exit(1);
  }
})();
