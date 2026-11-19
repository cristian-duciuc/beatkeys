// Captures everything the Mac plays through a Core Audio process tap (macOS 14.2+)
// and writes it to stdout as mono 32-bit float samples.
// Prints "rate <hz>" to stderr once capture has started.
import AudioToolbox
import CoreAudio
import Foundation

func fail(_ message: String, _ status: OSStatus = noErr) -> Never {
    let detail = status == noErr ? "" : " (OSStatus \(status))"
    FileHandle.standardError.write("error \(message)\(detail)\n".data(using: .utf8)!)
    exit(1)
}

func check(_ status: OSStatus, _ message: String) {
    if status != noErr { fail(message, status) }
}

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
}

func defaultOutputUID() -> String {
    var addr = address(kAudioHardwarePropertyDefaultOutputDevice)
    var device = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    check(
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &device),
        "no default output device")
    addr = address(kAudioDevicePropertyDeviceUID)
    var uid: Unmanaged<CFString>?
    size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    check(AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &uid), "cannot read the output device UID")
    return uid!.takeRetainedValue() as String
}

signal(SIGPIPE, SIG_IGN)

// A private, unmuted tap of every process, mixed down to mono.
let tap = CATapDescription(monoGlobalTapButExcludeProcesses: [])
tap.uuid = UUID()
tap.muteBehavior = .unmuted
tap.isPrivate = true
var tapID = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateProcessTap(tap, &tapID), "cannot create the process tap (needs macOS 14.2 or later)")

var formatAddr = address(kAudioTapPropertyFormat)
var format = AudioStreamBasicDescription()
var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
check(AudioObjectGetPropertyData(tapID, &formatAddr, 0, nil, &formatSize, &format), "cannot read the tap format")

// The tap is read through a private aggregate device built on the current output device.
let outputUID = defaultOutputUID()
let aggregate: [String: Any] = [
    kAudioAggregateDeviceNameKey: "VU Meter Tap",
    kAudioAggregateDeviceUIDKey: UUID().uuidString,
    kAudioAggregateDeviceMainSubDeviceKey: outputUID,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
    kAudioAggregateDeviceTapListKey: [
        [kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tap.uuid.uuidString]
    ],
]
var aggregateID = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID), "cannot create the aggregate device")

var procID: AudioDeviceIOProcID?

func cleanup() {
    if let procID {
        AudioDeviceStop(aggregateID, procID)
        AudioDeviceDestroyIOProcID(aggregateID, procID)
    }
    AudioHardwareDestroyAggregateDevice(aggregateID)
    AudioHardwareDestroyProcessTap(tapID)
}

let queue = DispatchQueue(label: "beatkeys.audio-tap")
check(
    AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { _, input, _, _, _ in
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        guard let buffer = buffers.first, let data = buffer.mData else { return }
        var offset = 0
        let total = Int(buffer.mDataByteSize)
        while offset < total {
            let written = write(STDOUT_FILENO, data + offset, total - offset)
            if written <= 0 {
                // The reader went away.
                cleanup()
                exit(0)
            }
            offset += written
        }
    }, "cannot create the capture callback")
check(AudioDeviceStart(aggregateID, procID), "cannot start capturing")

var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
        cleanup()
        exit(0)
    }
    source.resume()
    signalSources.append(source)
}

FileHandle.standardError.write("rate \(Int(format.mSampleRate))\n".data(using: .utf8)!)
dispatchMain()
