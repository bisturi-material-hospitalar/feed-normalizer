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
  s = s.replace(/[^\d.,]/g,''); // remove tudo exceto dígitos, . e ,
  s = s.replace(/\.(?=\d{3}([.,]|$))/g, ''); // remove pontos de milhares
  s = s.replace(/,/g, '.');
  const n = Number(s);
  return isNaN(n) ? s : n.toFixed(2);
}

function transformXml(xml){
  if(!/^\s*<\?xml/i.test(xml)) xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;

  xml = xml.replace(/<g:(id|mpn|gtin)>\s*<!\[CDATA\[\s*([\s\S]*?)\s*\]\]>\s*<\/g:\1>/gi,
    (_, tag, inner) => `<g:${tag}><![CDATA[${inner.trim()}]]></g:${tag}>`);

  xml = xml.replace(/<g:price>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/g:price>/gi, (_, inner) => {
    const num = (inner.match(/[\d\.,]+/)||[])[0]||'';
    return `<g:price>${normalizePriceRaw(num)} BRL</g:price>`;
  });
  xml = xml.replace(/<g:price>\s*([^<]+?)\s*<\/g:price>/gi, (_, inner) => {
    const num = (inner.match(/[\d\.,]+/)||[])[0]||'';
    return `<g:price>${normalizePriceRaw(num)} BRL</g:price>`;
  });

  xml = xml.replace(/<g:amount>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/g:amount>/gi, (_, inner) => {
    const num = (inner.match(/[\d\.,]+/)||[])[0]||'';
    return `<g:amount>${normalizePriceRaw(num)} BRL</g:amount>`;
  });

  xml = xml.replace(/<g:availability>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/g:availability>/gi, (_, inner) => {
    const val = inner.trim().toLowerCase();
    if(/disp|dispon|available|in stock/i.test(val)) return `<g:availability><![CDATA[in stock]]></g:availability>`;
    if(/esgot|indispon|out of stock|unavailable/i.test(val)) return `<g:availability><![CDATA[out of stock]]></g:availability>`;
    return `<g:availability><![CDATA[in stock]]></g:availability>`;
  });

  xml = xml.replace(/<g:image_link\s*\/>/gi, '<g:image_link></g:image_link>');

  if(!/<channel[\s>]/i.test(xml)){
    const items = Array.from(xml.matchAll(/<item[\s\S]*?<\/item>/gi)).map(m => m[0]).join('\n');
    const rssOpen = (xml.match(/<rss[^>]*>/i)||[])[0] || '<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">';
    const decl = (xml.match(/<\?xml[^>]*\?>/i)||[])[0] || '<?xml version="1.0" encoding="UTF-8"?>';
    xml = `${decl}\n${rssOpen}\n<channel>\n<title>Bisturi Material Hospitalar</title>\n<link>https://www.bisturi.com.br</link>\n<description>Feed normalizado</description>\n${items}\n</channel>\n</rss>`;
  }

  return xml;
}

async function fetchWithRetry(url){
  // se um arquivo local existir (produzido pelo step curl), use-o
  try {
    const stat = await fs.stat(LOCAL_FEED);
    if(stat && stat.isFile()){
      console.log('Usando arquivo local', LOCAL_FEED);
      return await fs.readFile(LOCAL_FEED, 'utf8');
    }
  } catch(e){ /* não existe, segue fetch remoto */ }

  for(let attempt=1; attempt<=MAX_RETRIES; attempt++){
    console.log(`Tentativa ${attempt}/${MAX_RETRIES} - fetch ${url}`);
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

      console.log('Status remoto:', res.status);
      if(!res.ok){
        const bodySnippet = await res.text().then(t => t.slice(0,1000)).catch(()=>'<no body>');
        console.log('Resposta com erro (snippet):', bodySnippet);
        throw new Error('Fetch retornou status ' + res.status);
      }
      const text = await res.text();
      return text;
    } catch(err){
      console.log('Erro no fetch:', err.message || err.toString());
      if(attempt < MAX_RETRIES){
        const wait = 1000 * Math.pow(2, attempt); // backoff exponencial
        console.log(`Aguardando ${wait}ms antes da próxima tentativa...`);
        await sleep(wait);
      } else {
        throw new Error('Falha ao buscar feed após ' + MAX_RETRIES + ' tentativas: ' + err.message);
      }
    }
  }
}

(async () => {
  try {
    console.log('Buscando feed (local ou remoto)...');
    const xmlRaw = await fetchWithRetry(FEED_URL);
    const out = transformXml(xmlRaw);
    await fs.mkdir(path.dirname(OUT), { recursive: true });
    await fs.writeFile(OUT, out, 'utf8');
    console.log('Gerado', OUT);
  } catch(err){
    console.error('Erro:', err);
    process.exit(1);
  }
})();
