import sharp from 'sharp';
import path from 'path';
import fs from 'fs';


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

     // Parse the optional watermark URL
    const watermarkUrl = req.query.watermark;

        try {
      // 3. Fetch remote image assets
      const fetchPromises = [fetch(targetUrl)];
      
      // Only fetch remotely if a watermark URL is provided AND it isn't the keyword "local"
      if (watermarkUrl && watermarkUrl !== 'local') {
        fetchPromises.push(fetch(watermarkUrl));
      }

      // Execute fetches and store in 'responses' exactly ONCE
      const responses = await Promise.all(fetchPromises);
      const logoResponse = responses[0];

      if (!logoResponse.ok) {
        return res.status(404).send('Error: Channel logo asset not found.');
      }

      const logoBuffer = Buffer.from(await logoResponse.arrayBuffer());

            // 4. FIRST PIPELINE: Execute base resize, background fill, and flush to buffer
      let basePipeline = sharp(logoBuffer).resize({
        width,
        height,
        fit: 'contain',
        background: bgColor 
      });

      if (bgColor.alpha === 1) {
        basePipeline = basePipeline.flatten({ background: bgColor });
      }

      // We explicitly convert to PNG buffer here to lock in the dimensions 
      // and guarantee the alpha channel is ready for masking.
      const sizedBuffer = await basePipeline.ensureAlpha().png().toBuffer();

      // 5. SECOND PIPELINE: Initialize new pipeline with the correctly sized buffer
      let pipeline = sharp(sizedBuffer);
      const compositeOperations = [];

      // A. Apply the dynamic vector mask if a frame is requested
      if (frame === 'circle') {
        const radius = Math.min(width, height) / 2;
        const circleMask = Buffer.from(
          `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><circle cx="${width / 2}" cy="${height / 2}" r="${radius}" fill="#fff" /></svg>`
        );
        compositeOperations.push({ input: circleMask, blend: 'dest-in' });
      } else if (frame === 'rounded') {
        const rx = Math.min(width, height) * 0.1; 
        const roundedMask = Buffer.from(
          `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="${width}" height="${height}" rx="${rx}" ry="${rx}" fill="#fff" /></svg>`
        );
        compositeOperations.push({ input: roundedMask, blend: 'dest-in' });
      }

      // B. Apply the Watermark
      if (watermarkUrl) {
        let wmBuffer = null;

        // Determine if we are loading the local file or the remote fetch response
        if (watermarkUrl === 'local') {
          const localPath = path.join(process.cwd(), 'assets', 'watermark.png');
          if (fs.existsSync(localPath)) {
            wmBuffer = fs.readFileSync(localPath);
          }
        } else if (responses[1] && responses[1].ok) {
          wmBuffer = Buffer.from(await responses[1].arrayBuffer());
        }

        // If we successfully grabbed a watermark buffer (local or remote), apply it
        if (wmBuffer) {
          const validPositions = ['center', 'north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
          const wmPos = validPositions.includes(req.query.wm_pos) ? req.query.wm_pos : 'southeast';
          const wmOpacity = Math.min(Math.max(parseFloat(req.query.wm_op) || 1, 0.1), 1);

          const wmTargetWidth = Math.max(Math.floor(width * 0.25), 20);
          
          let wmPipeline = sharp(wmBuffer).resize({ width: wmTargetWidth }).ensureAlpha();

          if (wmOpacity < 1) {
            const alphaVal = Math.round(wmOpacity * 255);
            wmPipeline = wmPipeline.composite([{
              input: Buffer.from([255, 255, 255, alphaVal]),
              raw: { width: 1, height: 1, channels: 4 },
              tile: true,
              blend: 'dest-in' 
            }]);
          }

          const processedWatermark = await wmPipeline.toBuffer();
          compositeOperations.push({ input: processedWatermark, gravity: wmPos, blend: 'over' });
        }
      }

      // Execute all overlays (masks + watermarks) in one efficient pass
      if (compositeOperations.length > 0) {
        pipeline = pipeline.composite(compositeOperations);
      }

      // 6. Output final transformation compile
      const finalImageBuffer = await pipeline
        .png({ quality, compressionLevel: 8 })
        .toBuffer();

    // 7. Establish downstream network headers for browser & CDN caching
    res.setHeader('Content-Type', 'image/png');

// Browser caches for 7 days | Edge CDNs cache for 30 days | SWR background updates for 1 day

    res.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=2592000, stale-while-revalidate=86400');

    
    return res.status(200).send(finalImageBuffer);

  } catch (error) {
    console.error('Proxy Error:', error.message);
    return res.status(500).send('Internal Server Error processing image execution.');
  }
}
