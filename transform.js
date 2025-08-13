
import fs from 'fs/promises';

const FEED_URL = 'https://www.bisturi.com.br/XMLData/feed-dinamize.xml';
const OUT_PATH = 'docs/feed-dinamize.xml';

function normalizePriceRaw(raw) {
  if (!raw) return raw;
  let s = raw.replace(/\s+/g, ' ');
  s = s.replace(/[^\d.,]/g, '');
  const withoutThousands = s.replace(/\.(?=\d{3}([.,]|$))/g, '');
  const normalized = withoutThousands.replace(/,/g, '.');
  const n = Number(normalized);
  return isNaN(n) ? normalized : n.toFixed(2);
}

function transformXml(xml) {
  // garante declaração
  if (!/^\s*<\?xml/i.test(xml)) xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;

  // trim em id, mpn, gtin
  xml = xml.replace(/<g:(id|mpn|gtin)>\s*<!\[CDATA\[\s*([\s\S]*?)\s*\]\]>\s*<\/g:\1>/gi,
    (_, tag, inner) => `<g:${tag}><![CDATA[${inner.trim()}]]></g:${tag}>`);

  // g:price com CDATA
  xml = xml.replace(/<g:price>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/g:price>/gi, (_, inner) => {
    const formatted = normalizePriceRaw(inner);
    return `<g:price>${formatted} BRL</g:price>`;
  });

  // g:price sem CDATA
  xml = xml.replace(/<g:price>\s*([^<]+?)\s*<\/g:price>/gi, (_, inner) => {
    const formatted = normalizePriceRaw(inner);
    return `<g:price>${formatted} BRL</g:price>`;
  });

  // g:installment g:amount
  xml = xml.replace(/<g:amount>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/g:amount>/gi, (_, inner) => {
    const formatted = normalizePriceRaw(inner);
    return `<g:amount>${formatted} BRL</g:amount>`;
  });

  // availability PT -> EN
  xml = xml.replace(/<g:availability>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/g:availability>/gi, (_, inner) => {
    const val = inner.trim().toLowerCase();
    if (/disp|dispon|available|in stock/i.test(val)) return `<g:availability><![CDATA[in stock]]></g:availability>`;
    if (/esgot|indispon|out of stock|unavailable/i.test(val)) return `<g:availability><![CDATA[out of stock]]></g:availability>`;
    return `<g:availability><![CDATA[in stock]]></g:availability>`;
  });

  // g:image_link vazio -> vazio
  xml = xml.replace(/<g:image_link\s*\/>/gi, '<g:image_link></g:image_link>');

  // encapsula channel se faltar
  if (!/<channel[\s>]/i.test(xml)) {
    const items = Array.from(xml.matchAll(/<item[\s\S]*?<\/item>/gi)).map(m => m[0]).join('\n');
    const rssOpen = xml.match(/<rss[^>]*>/i)?.[0] || '<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">';
    const decl = xml.match(/<\?xml[^>]*\?>/i)?.[0] || '<?xml version="1.0" encoding="UTF-8"?>';
    xml = `${decl}\n${rssOpen}\n<channel>\n<title>Bisturi Material Hospitalar</title>\n<link>https://www.bisturi.com.br</link>\n<description>Feed normalizado</description>\n${items}\n</channel>\n</rss>`;
  }

  return xml;
}

async function run() {
  console.log('Fetching', FEED_URL);
  const res = await fetch(FEED_URL);
  if (!res.ok) throw new Error('Status ' + res.status);
  let xml = await res.text();
  const transformed = transformXml(xml);
  await fs.mkdir('docs', { recursive: true });
  await fs.writeFile(OUT_PATH, transformed, 'utf8');
  console.log('Wrote', OUT_PATH);
}

run().catch(e => { console.error(e); process.exit(1); });
