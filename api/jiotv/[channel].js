import sharp from 'sharp';

// Helper function to validate and convert hex colors safely
const parseHexColor = (hex) => {
  if (!hex) return { r: 0, g: 0, b: 0, alpha: 0 }; // Default transparent
  const cleanHex = hex.replace('#', '');
  if (!/^[0-9A-F]{6}$/i.test(cleanHex)) return { r: 0, g: 0, b: 0, alpha: 0 };
  
  return {
    r: parseInt(cleanHex.substring(0, 2), 16),
    g: parseInt(cleanHex.substring(2, 4), 16),
    b: parseInt(cleanHex.substring(4, 6), 16),
    alpha: 1
  };
};

export default async function handler(req, res) {
  // Extract filename from path (e.g., "Sony_SAB.png")
  const { channel } = req.query;

  if (!channel) {
    return res.status(400).send('Error: Channel parameter missing.');
  }

  // 1. Reconstruct the clean upstream target URL
  const BASE_CDN = 'https://jiotvimages.cdn.jio.com/dare_images/images/';
  const targetUrl = `${BASE_CDN}${channel}`;

  // 2. Parse and sanitize query configuration parameters
  const width = Math.min(Math.max(parseInt(req.query.width || req.query.w) || 400, 10), 2000);
  const height = Math.min(Math.max(parseInt(req.query.height || req.query.h) || 400, 10), 2000);
  const quality = Math.min(Math.max(parseInt(req.query.quality || req.query.q) || 85, 1), 100);
  const frame = req.query.frame || 'square'; // Options: square, rounded, circle
  
  // Parse background color (e.g., bg=1e1e1e)
  const bgColor = parseHexColor(req.query.bg);

  try {
    // 3. Fetch remote image asset
    const response = await fetch(targetUrl);
    if (!response.ok) {
      return res.status(404).send('Error: Channel logo asset not found.');
    }

    const arrayBuffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);

// 4. Initialize pipeline and execute base resize/background fill
    let pipeline = sharp(imageBuffer).resize({
      width,
      height,
      fit: 'contain',
      background: bgColor // This colors the extra padding
    });

    // NEW: If a custom background was requested (alpha is 1), 
    // flatten the transparent image pixels onto that color.
    if (bgColor.alpha === 1) {
      pipeline = pipeline.flatten({ background: bgColor });
    }

    // 5. Apply dynamic vector masks for frame variations
    if (frame === 'circle') {
      const radius = Math.min(width, height) / 2;
      const circleMask = Buffer.from(
        `<svg width="${width}" height="${height}">
          <circle cx="${width / 2}" cy="${height / 2}" r="${radius}" fill="#fff" />
        </svg>`
      );
      pipeline = pipeline.composite([{ input: circleMask, blend: 'dest-in' }]);
    } else if (frame === 'rounded') {
      const rx = Math.min(width, height) * 0.1; // Dynamic 10% corner radius
      const roundedMask = Buffer.from(
        `<svg width="${width}" height="${height}">
          <rect x="0" y="0" width="${width}" height="${height}" rx="${rx}" ry="${rx}" fill="#fff" />
        </svg>`
      );
      pipeline = pipeline.composite([{ input: roundedMask, blend: 'dest-in' }]);
    }

    // 6. Output transformation compile
    const finalImageBuffer = await pipeline
      .png({ quality, compressionLevel: 8 })
      .toBuffer();

    // 7. Establish downstream network headers for browser & CDN caching
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=86400, stale-while-revalidate=3600');
    
    return res.status(200).send(finalImageBuffer);

  } catch (error) {
    console.error('Proxy Error:', error.message);
    return res.status(500).send('Internal Server Error processing image execution.');
  }
}
