const fs = require('fs').promises;
const FEED_URL = 'https://www.bisturi.com.br/XMLData/feed-dinamize.xml';
const OUT = 'docs/feed-dinamize.xml';

function normalizePriceRaw(raw){
  if(!raw) return raw;
  let s = String(raw).replace(/\s+/g,' ');
  s = s.replace(/[^\d.,]/g,''); // remove tudo exceto dígitos, . e ,
  // remove pontos que são separador de milhares (apenas quando aparecem antes de grupos de 3 dígitos)
  s = s.replace(/\.(?=\d{3}([.,]|$))/g, '');
  s = s.replace(/,/g, '.');
  const n = Number(s);
  return isNaN(n) ? s : n.toFixed(2);
}

function transformXml(xml){
  if(!/^\s*<\?xml/i.test(xml)) xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;

  // trim id, mpn, gtin dentro de CDATA
  xml = xml.replace(/<g:(id|mpn|gtin)>\s*<!\[CDATA\[\s*([\s\S]*?)\s*\]\]>\s*<\/g:\1>/gi,
    (_, tag, inner) => `<g:${tag}><![CDATA[${inner.trim()}]]></g:${tag}>`);

  // <g:price> com e sem CDATA
  xml = xml.replace(/<g:price>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/g:price>/gi, (_, inner) => {
    const num = (inner.match(/[\d\.,]+/)||[])[0]||'';
    return `<g:price>${normalizePriceRaw(num)} BRL</g:price>`;
  });
  xml = xml.replace(/<g:price>\s*([^<]+?)\s*<\/g:price>/gi, (_, inner) => {
    const num = (inner.match(/[\d\.,]+/)||[])[0]||'';
    return `<g:price>${normalizePriceRaw(num)} BRL</g:price>`;
  });

  // g:amount (parcelas)
  xml = xml.replace(/<g:amount>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/g:amount>/gi, (_, inner) => {
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

  // g:image_link vazio -> keep empty tag (avoid self-closed)
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

(async () => {
  try {
    console.log('Buscando', FEED_URL);
    const r = await fetch(FEED_URL);
    if(!r.ok) throw new Error('Status ' + r.status);
    let xml = await r.text();
    const out = transformXml(xml);
    await fs.mkdir('docs', { recursive: true });
    await fs.writeFile(OUT, out, 'utf8');
    console.log('Gerado', OUT);
  } catch(err){
    console.error('Erro:', err);
    process.exit(1);
  }
})();
