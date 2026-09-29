// Remove background using macOS Vision foreground instance mask.
// Usage: swift scripts/bgremove.swift <in> <out>
import AppKit
import Vision
import CoreImage

guard CommandLine.arguments.count == 3 else { print("usage: bgremove in out"); exit(1) }
let inPath = CommandLine.arguments[1], outPath = CommandLine.arguments[2]
guard let img = NSImage(contentsOfFile: inPath),
      let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let cg = rep.cgImage else { print("load failed"); exit(1) }

let w = cg.width, h = cg.height
let cs = CGColorSpaceCreateDeviceRGB()

// 1) Draw original into an RGBA buffer (big-endian RGBA, premultipliedLast)
var rgba = [UInt8](repeating: 0, count: w * h * 4)
do {
  guard let c = CGContext(data: &rgba, width: w, height: h, bitsPerComponent: 8,
                          bytesPerRow: w * 4, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }
  c.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
}

// 2) Vision mask
let req = VNGenerateForegroundInstanceMaskRequest()
let handler = VNImageRequestHandler(cgImage: cg)
try handler.perform([req])
guard let obs = req.results?.first,
      let maskBuf = try? obs.generateScaledMaskForImage(forInstances: obs.allInstances, from: handler) else {
  print("no mask"); exit(1)
}
let maskImg = CIImage(cvPixelBuffer: maskBuf)
let ciContext = CIContext()
guard let maskCG = ciContext.createCGImage(maskImg, from: maskImg.extent) else { exit(1) }

// 3) Draw mask (grayscale) into its own buffer; take red channel as alpha
var mpx = [UInt8](repeating: 0, count: w * h * 4)
do {
  guard let c = CGContext(data: &mpx, width: w, height: h, bitsPerComponent: 8,
                          bytesPerRow: w * 4, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }
  c.draw(maskCG, in: CGRect(x: 0, y: 0, width: w, height: h))
}

// 4) Combine alpha
for i in 0..<(w * h) {
  rgba[i * 4 + 3] = mpx[i * 4]
}

guard let outCtx = CGContext(data: &rgba, width: w, height: h, bitsPerComponent: 8,
                             bytesPerRow: w * 4, space: cs,
                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
      let outCG = outCtx.makeImage() else { exit(1) }
let rep2 = NSBitmapImageRep(cgImage: outCG)
rep2.size = NSSize(width: w, height: h)
guard let png = rep2.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: outPath))
print("wrote \(outPath) \(w)x\(h)")
