"""Compile and execute the actual Swift transfer budget on the Mac runner.

The error facade supplies only the transport's error type. All reservation,
duplicate-key, shared-limit and byte-accounting behavior comes from the real
GDTransferBudget.swift; the actor harness matches its client-owned isolation.
"""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

NATIVE=Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform=="darwin","Swift transfer budget runs on the Mac validation runner")
class TransferBudgetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary=tempfile.TemporaryDirectory(prefix="gendragoon-transfer-budget-")
        cls.addClassCleanup(cls.temporary.cleanup)
        root=Path(cls.temporary.name).resolve()
        source=root/"BudgetHarness.swift"
        source.write_text(HARNESS)
        cls.binary=root/"budget-harness"
        result=subprocess.run(["/usr/bin/xcrun","swiftc","-parse-as-library",
            str(NATIVE/"Sources/GDTransferBudget.swift"),str(source),"-o",str(cls.binary)],
            capture_output=True,text=True,timeout=60)
        if result.returncode:
            raise AssertionError("Actual Swift budget fixture did not compile:\n"+result.stderr[-8000:])

    def run_case(self,name):
        result=subprocess.run([str(self.binary),name],capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(result.stdout.strip(),name+" passed")

    def test_concurrent_files_share_one_worker_allowance(self):self.run_case("concurrency")
    def test_duplicate_keys_cannot_replace_a_live_lease(self):self.run_case("duplicates")
    def test_tier_reduction_limits_new_leases_without_erasing_active_work(self):self.run_case("tier-reduction")
    def test_download_byte_reservations_are_shared_and_released_exactly(self):self.run_case("download-bytes")
    def test_cancellation_releases_workers_and_reserved_download_bytes(self):self.run_case("cancellation")
    def test_invalid_caps_fail_without_reserving_resources(self):self.run_case("invalid-caps")


HARNESS=r'''
import Foundation

struct GDTransferError: Error, Sendable { let message: String; let status: Int }

actor Started {
    private var ready=false
    private var waiting:[CheckedContinuation<Void,Never>]=[]
    func signal() { ready=true; let all=waiting;waiting=[];for waiter in all{waiter.resume()} }
    func wait() async { if ready{return};await withCheckedContinuation{waiting.append($0)} }
}
actor ClientBudget {
    private var budget=GDTransferBudget()
    func reserve(_ key:String,limit:Int,workers:Int,bytes:Int64=0) -> Bool {
        do{_ = try budget.reserve(key:key,verifiedLimit:limit,requestedWorkers:workers,downloadBytes:bytes);return true}
        catch{return false}
    }
    func release(_ key:String){budget.release(key:key)}
    func snapshot()->(workers:Int,bytes:Int64,count:Int){(budget.workersInUse,budget.reservedDownloadBytes,budget.leases.count)}
    func cancellable(started:Started) async throws {
        _ = try budget.reserve(key:"cancelled-file",verifiedLimit:8,requestedWorkers:3,downloadBytes:8192)
        defer{budget.release(key:"cancelled-file")}
        await started.signal()
        try await Task.sleep(nanoseconds:30_000_000_000)
    }
}
func reject(_ operation:() throws->Void){
    do{try operation();fatalError("The invalid reservation unexpectedly succeeded")}
    catch is GDTransferError{}
    catch{fatalError("Unexpected reservation error: \(error)")}
}

@main struct BudgetHarness {
    static func main() async throws {
        let name=CommandLine.arguments[1]
        switch name {
        case "concurrency":
            let client=ClientBudget()
            let accepted=await withTaskGroup(of:(Int,Bool).self,returning:[Int].self){group in
                for key in 0..<40{group.addTask{(key,await client.reserve("file-\(key)",limit:8,workers:2,bytes:1024))}}
                var accepted:[Int]=[]
                for await (key,success) in group{if success{accepted.append(key)}}
                return accepted
            }
            precondition(accepted.count==4,"A batch multiplied its shared worker cap")
            let active=await client.snapshot()
            precondition(active.workers==8 && active.bytes==4096 && active.count==4)
            for key in accepted{await client.release("file-\(key)")}
            let after=await client.snapshot();precondition(after.workers==0 && after.bytes==0 && after.count==0)
        case "duplicates":
            let client=ClientBudget()
            let accepted=await withTaskGroup(of:Bool.self,returning:Int.self){group in
                for _ in 0..<20{group.addTask{await client.reserve("same-file",limit:24,workers:1,bytes:99)}}
                var count=0;for await ok in group{if ok{count+=1}};return count
            }
            precondition(accepted==1)
            let active=await client.snapshot();precondition(active.workers==1 && active.bytes==99 && active.count==1)
            await client.release("unknown-key")
            let unchanged=await client.snapshot();precondition(unchanged.workers==1 && unchanged.bytes==99)
            await client.release("same-file");await client.release("same-file")
            let after=await client.snapshot();precondition(after.workers==0 && after.bytes==0)
        case "tier-reduction":
            var budget=GDTransferBudget()
            _ = try budget.reserve(key:"older-tier",verifiedLimit:24,requestedWorkers:8)
            reject{_ = try budget.reserve(key:"lower-tier",verifiedLimit:4,requestedWorkers:1)}
            precondition(budget.workersInUse==8 && budget.leases.count==1)
            budget.release(key:"older-tier")
            _ = try budget.reserve(key:"lower-tier",verifiedLimit:4,requestedWorkers:1)
            _ = try budget.reserve(key:"older-response",verifiedLimit:24,requestedWorkers:3)
            reject{_ = try budget.reserve(key:"cannot-overbook",verifiedLimit:24,requestedWorkers:1)}
            precondition(budget.workersInUse==4)
            budget.release(key:"lower-tier");budget.release(key:"older-response")
            let upgraded=try budget.reserve(key:"new-confirmed-upgrade",verifiedLimit:24,requestedWorkers:nil)
            precondition(upgraded==24)
        case "download-bytes":
            var budget=GDTransferBudget()
            let GiB:Int64=1024*1024*1024
            _ = try budget.reserve(key:"first-download",verifiedLimit:8,requestedWorkers:2,downloadBytes:4*GiB)
            _ = try budget.reserve(key:"second-download",verifiedLimit:8,requestedWorkers:3,downloadBytes:6*GiB)
            _ = try budget.reserve(key:"upload",verifiedLimit:8,requestedWorkers:1)
            precondition(budget.reservedDownloadBytes==10*GiB && budget.workersInUse==6)
            let free:Int64=18*GiB,reserve:Int64=10*GiB,ownCompleted:Int64=GiB
            precondition(free < budget.reservedDownloadBytes-ownCompleted+reserve,
                "The second restore must count other active download reservations")
            budget.release(key:"first-download")
            precondition(budget.reservedDownloadBytes==6*GiB && budget.workersInUse==4)
            budget.release(key:"second-download")
            precondition(budget.reservedDownloadBytes==0 && budget.workersInUse==1)
            budget.release(key:"upload")
            for i in 0..<24{_ = try budget.reserve(key:"large-\(i)",verifiedLimit:24,requestedWorkers:1,downloadBytes:4_000_000_000_000)}
            precondition(budget.reservedDownloadBytes==96_000_000_000_000)
        case "cancellation":
            let client=ClientBudget(),started=Started()
            let operation=Task{try await client.cancellable(started:started)}
            await started.wait()
            let active=await client.snapshot();precondition(active.workers==3 && active.bytes==8192)
            operation.cancel()
            do{try await operation.value;fatalError("Cancelled transfer completed unexpectedly")}
            catch is CancellationError{}
            let released=await client.snapshot();precondition(released.workers==0 && released.bytes==0 && released.count==0)
            let replacement=await client.reserve("replacement",limit:8,workers:8)
            precondition(replacement)
        case "invalid-caps":
            var budget=GDTransferBudget()
            for limit in [-1,0,25,Int.max]{reject{_ = try budget.reserve(key:"invalid-limit",verifiedLimit:limit,requestedWorkers:1)}}
            for workers in [-1,0,25,Int.max]{reject{_ = try budget.reserve(key:"invalid-workers",verifiedLimit:24,requestedWorkers:workers)}}
            for bytes in [Int64(-1),4_000_000_000_001,Int64.max]{reject{_ = try budget.reserve(key:"invalid-bytes",verifiedLimit:24,requestedWorkers:1,downloadBytes:bytes)}}
            reject{_ = try budget.reserve(key:"",verifiedLimit:24,requestedWorkers:1)}
            precondition(budget.leases.isEmpty && budget.reservedDownloadBytes==0)
            let capped=try budget.reserve(key:"capped",verifiedLimit:2,requestedWorkers:24)
            precondition(capped==2)
        default:fatalError("Unknown test case")
        }
        print(name+" passed")
    }
}
'''


if __name__=="__main__":unittest.main()
