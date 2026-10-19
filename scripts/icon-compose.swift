// compose <full-bleed.png> <out.png> <size>: an Icon Composer render on the macOS icon grid (the shape 824/1024 of the
// canvas, centred) with the drop shadow macOS draws under app icons. Used by scripts/build-icon.sh.
import AppKit
let a = CommandLine.arguments
let src = NSImage(contentsOfFile: a[1])!.cgImage(forProposedRect: nil, context: nil, hints: nil)!
let size = Int(a[3])!
let s = CGFloat(size) / 1024
let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.interpolationQuality = .high
ctx.setShadow(offset: CGSize(width: 0, height: -10 * s), blur: 20 * s, color: CGColor(gray: 0, alpha: 0.3))
ctx.draw(src, in: CGRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s))
let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[2]))
