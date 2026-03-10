const Busboy = require('busboy');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('multipart/form-data')) {
      const busboy = Busboy({ headers: req.headers });
      const chunks = [];
      let filename = 'upload';
      let mimeType = 'application/octet-stream';

      await new Promise((resolve, reject) => {
        busboy.on('file', (fieldname, file, info) => {
          filename = info.filename || 'upload';
          mimeType = info.mimeType || 'application/octet-stream';
          file.on('data', chunk => chunks.push(chunk));
          file.on('end', () => {});
        });
        busboy.on('finish', resolve);
        busboy.on('error', reject);
        req.pipe(busboy);
      });

      const buffer = Buffer.concat(chunks);
      const base64 = buffer.toString('base64');
      return res.status(200).json({ name: filename, mimeType, base64, size: buffer.length });
    } else {
      return res.status(400).json({ error: 'Expected multipart/form-data' });
    }
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
};
