// memfoot: physical memory footprint (what Activity Monitor's Memory column shows) of each pid given, as JSON
// {"<pid>": bytes}. Unlike ps RSS it counts GPU / Metal memory (MLX models) and compressed pages. Pids that are
// gone or not ours are left out. Built and run by server/memory.ts.
//   memfoot 123 456   →   {"123":2516582400,"456":36700160}
import Darwin
import Foundation

var out: [String: UInt64] = [:]
for arg in CommandLine.arguments.dropFirst() {
  guard let pid = Int32(arg) else { continue }
  var info = rusage_info_v4()
  let ok = withUnsafeMutablePointer(to: &info) { p in
    p.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
  }
  if ok == 0 { out[arg] = info.ri_phys_footprint }
}
let data = try! JSONSerialization.data(withJSONObject: out)
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
