// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// twindesk-vcam (TwinDesk.app/Contents/MacOS, beside the app: the system extension it installs
// must be in its main bundle): the virtual camera's side in TwinDesk (mac/vcam.js).
//   activate    installs the Camera Extension (org.macshare.mac.camera); the first time macOS asks
//               the person to allow it in System Settings: {"approval":true} is printed meanwhile,
//               and it waits (up to 5 minutes) for the answer
//   deactivate  removes it
//   status      {"camera":true|false}: is "TwinDesk Camera" among this Mac's cameras
//   feed        frames on stdin, each 1280×720 NV12 (shared/vcam-feed.js), into the camera's sink stream
import CoreMediaIO
import CoreMedia
import CoreVideo
import Foundation
import SystemExtensions

let extensionID = "org.macshare.mac.camera"
let cameraName = "TwinDesk Camera"
let width = 1280, height = 720
let frameBytes = width * height * 3 / 2

func say(_ obj: [String: Any]) {
  if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) {
    print(s)
    fflush(stdout)
  }
}

// ---- installing ----

class Request: NSObject, OSSystemExtensionRequestDelegate {
  func request(_ request: OSSystemExtensionRequest, actionForReplacingExtension existing: OSSystemExtensionProperties, withExtension ext: OSSystemExtensionProperties) -> OSSystemExtensionRequest.ReplacementAction {
    .replace
  }
  func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
    say(["approval": true])
  }
  func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
    say(["ok": true, "reboot": result == .willCompleteAfterReboot])
    exit(0)
  }
  func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
    say(["ok": false, "error": error.localizedDescription, "code": (error as NSError).code])
    exit(1)
  }
}

func install(_ activate: Bool) -> Never {
  let delegate = Request()
  let r = activate
    ? OSSystemExtensionRequest.activationRequest(forExtensionWithIdentifier: extensionID, queue: .main)
    : OSSystemExtensionRequest.deactivationRequest(forExtensionWithIdentifier: extensionID, queue: .main)
  r.delegate = delegate
  OSSystemExtensionManager.shared.submitRequest(r)
  DispatchQueue.main.asyncAfter(deadline: .now() + 300) {
    say(["ok": false, "error": "no answer from System Settings"])
    exit(1)
  }
  withExtendedLifetime(delegate) { dispatchMain() }
}

// ---- the camera, through CoreMediaIO ----

func property<T>(_ object: CMIOObjectID, _ selector: Int, scope: Int = kCMIOObjectPropertyScopeGlobal, _ empty: T) -> [T] {
  var addr = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(selector), mScope: CMIOObjectPropertyScope(scope), mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
  var size: UInt32 = 0
  guard CMIOObjectGetPropertyDataSize(object, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
  var items = [T](repeating: empty, count: Int(size) / MemoryLayout<T>.stride)
  var used: UInt32 = 0
  let status = items.withUnsafeMutableBytes { CMIOObjectGetPropertyData(object, &addr, 0, nil, size, &used, $0.baseAddress!) }
  return status == noErr ? items : []
}

func name(_ object: CMIOObjectID) -> String {
  var addr = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(kCMIOObjectPropertyName), mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal), mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
  var value: Unmanaged<CFString>?
  var used: UInt32 = 0
  guard CMIOObjectGetPropertyData(object, &addr, 0, nil, UInt32(MemoryLayout<Unmanaged<CFString>?>.size), &used, &value) == noErr, let v = value else { return "" }
  return v.takeRetainedValue() as String
}

func findCamera() -> CMIOObjectID? {
  property(CMIOObjectID(kCMIOObjectSystemObject), kCMIOHardwarePropertyDevices, CMIOObjectID(0)).first { name($0) == cameraName }
}

// The device's stream TwinDesk writes into: the one going into it (direction 0), else the last.
func sinkStream(_ device: CMIOObjectID) -> CMIOStreamID? {
  let streams = property(device, kCMIODevicePropertyStreams, CMIOStreamID(0))
  return streams.first { property($0, kCMIOStreamPropertyDirection, UInt32(1)).first == 0 } ?? streams.last
}

func readAll(_ buf: UnsafeMutablePointer<UInt8>, _ count: Int) -> Bool {
  var got = 0
  while got < count {
    let n = read(0, buf + got, count - got)
    if n <= 0 { return false }
    got += n
  }
  return true
}

func feed() -> Never {
  // Wait for the camera (just installed: it shows up in a moment).
  var device: CMIOObjectID?
  for _ in 0..<50 {
    device = findCamera()
    if device != nil { break }
    usleep(100_000)
  }
  guard let dev = device, let stream = sinkStream(dev) else {
    FileHandle.standardError.write("no TwinDesk Camera\n".data(using: .utf8)!)
    exit(1)
  }
  var queue: Unmanaged<CMSimpleQueue>?
  let altered: CMIODeviceStreamQueueAlteredProc = { _, _, _ in }
  guard CMIOStreamCopyBufferQueue(stream, altered, nil, &queue) == noErr, let q = queue?.takeRetainedValue() else {
    FileHandle.standardError.write("no sink queue\n".data(using: .utf8)!)
    exit(1)
  }
  CMIODeviceStartStream(dev, stream)

  var format: CMFormatDescription?
  let ext: [String: Any] = [kCVImageBufferYCbCrMatrixKey as String: kCVImageBufferYCbCrMatrix_ITU_R_601_4]
  CMVideoFormatDescriptionCreate(allocator: kCFAllocatorDefault, codecType: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, width: Int32(width), height: Int32(height), extensions: ext as CFDictionary, formatDescriptionOut: &format)
  var pool: CVPixelBufferPool?
  let attrs: [String: Any] = [
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
    kCVPixelBufferIOSurfacePropertiesKey as String: [:],
  ]
  CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &pool)
  let frame = UnsafeMutablePointer<UInt8>.allocate(capacity: frameBytes)
  while readAll(frame, frameBytes) {
    // The camera takes one at a time: a frame it hasn't taken yet is replaced by a newer one later.
    if CMSimpleQueueGetCount(q) >= CMSimpleQueueGetCapacity(q) { continue }
    var pb: CVPixelBuffer?
    guard let p = pool, CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, p, &pb) == kCVReturnSuccess, let buf = pb else { continue }
    CVPixelBufferLockBaseAddress(buf, [])
    for plane in 0..<2 {
      guard let base = CVPixelBufferGetBaseAddressOfPlane(buf, plane) else { continue }
      let stride = CVPixelBufferGetBytesPerRowOfPlane(buf, plane)
      let rows = plane == 0 ? height : height / 2
      let src = frame + (plane == 0 ? 0 : width * height)
      for r in 0..<rows { memcpy(base + r * stride, src + r * width, width) }
    }
    CVPixelBufferUnlockBaseAddress(buf, [])
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30), presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()), decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    guard let f = format, CMSampleBufferCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buf, dataReady: true, makeDataReadyCallback: nil, refcon: nil, formatDescription: f, sampleTiming: &timing, sampleBufferOut: &sample) == noErr, let s = sample else { continue }
    let element = Unmanaged.passRetained(s)
    if CMSimpleQueueEnqueue(q, element: element.toOpaque()) != noErr { element.release() }
  }
  CMIODeviceStopStream(dev, stream)
  exit(0)
}

switch CommandLine.arguments.dropFirst().first ?? "" {
case "activate": install(true)
case "deactivate": install(false)
case "status": say(["ok": true, "camera": findCamera() != nil])
case "feed": feed()
default:
  FileHandle.standardError.write("usage: twindesk-vcam activate|deactivate|status|feed\n".data(using: .utf8)!)
  exit(2)
}
