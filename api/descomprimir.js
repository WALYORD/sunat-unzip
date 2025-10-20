const admZip = require('adm-zip');

module.exports = (req, res) => {
  // Configurar CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Manejar preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // Solo permitir POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }
  
  try {
    const { zip_data } = req.body;
    
    if (!zip_data) {
      return res.status(400).json({
        success: false,
        error: 'No se recibieron datos ZIP'
      });
    }
    
    // Decodificar base64
    const zipBuffer = Buffer.from(zip_data, 'base64');
    
    // Verificar tamaño mínimo
    if (zipBuffer.length < 100) {
      return res.status(400).json({
        success: false,
        error: `Archivo muy pequeño: ${zipBuffer.length} bytes`
      });
    }
    
    // Descomprimir
    const zipFile = new admZip(zipBuffer);
    const zipEntries = zipFile.getEntries();
    
    const files = [];
    
    zipEntries.forEach(entry => {
      if (!entry.isDirectory) {
        const content = entry.getData().toString('utf8');
        files.push({
          name: entry.entryName,
          size: content.length,
          line_count: content.split('\n').length,
          content: content
        });
      }
    });
    
    // Éxito
    res.json({
      success: true,
      files_count: files.length,
      files: files
    });
    
  } catch (error) {
    // Error
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
