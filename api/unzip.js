const admZip = require('adm-zip');

export default function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  
  try {
    const { zip_data } = req.body;
    
    if (!zip_data) {
      return res.status(400).json({ success: false, error: 'No hay datos ZIP' });
    }
    
    const zipBuffer = Buffer.from(zip_data, 'base64');
    
    if (zipBuffer.length < 100) {
      return res.status(400).json({ 
        success: false, 
        error: `Archivo pequeño: ${zipBuffer.length} bytes` 
      });
    }
    
    const zipFile = new admZip(zipBuffer);
    const files = [];
    
    zipFile.getEntries().forEach(entry => {
      if (!entry.isDirectory) {
        const content = entry.getData().toString('utf8');
        files.push({
          name: entry.entryName,
          content: content,
          line_count: content.split('\n').length
        });
      }
    });
    
    res.json({ success: true, files: files });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
