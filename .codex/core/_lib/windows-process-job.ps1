param([Parameter(Mandatory=$true)][string]$RequestFile)

# Windows Job Object stage runner. No user command is evaluated
# by PowerShell; the trusted bootstrap preserves literal Node argv semantics.
$ErrorActionPreference = 'Stop'
$request = [IO.File]::ReadAllText($RequestFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
$taskDirectory = Split-Path -Parent $RequestFile
$receiptFile = Join-Path $taskDirectory 'tree-proof.json'
$cancelFile = Join-Path $taskDirectory 'terminate.json'
$resultFile = Join-Path $taskDirectory 'stage-result.json'
$job = $null
$confirmed = $false
$exitCode = 1
$spawnError = $null
$nativeExitCode = $null
$owner = $null
try {
    # Capture the actual live owner process handle before compilation. Its
    # lifetime, rather than a later PID lookup, controls orphan cancellation.
    $owner = [Diagnostics.Process]::GetProcessById([int]$request.ownerPid)
    $null = $owner.Handle
    # Windows PowerShell compiles Add-Type through temporary source files.
    # A service-inherited system TEMP can allow directory creation yet deny
    # compiler access. Use this invocation's private directory only for that
    # compilation, then restore the configured command's environment.
    $previousTemp = $env:TEMP
    $previousTmp = $env:TMP
    try {
    $env:TEMP = $taskDirectory
    $env:TMP = $taskDirectory
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class OwnedStageJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
        public uint cb; public IntPtr reserved, desktop, title;
        public uint x,y,xSize,ySize,xCount,yCount,fill,flags;
        public ushort show,reserved2; public IntPtr reservedBytes,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
        public IntPtr process,thread; public uint pid,tid;
    }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
        public long processTime,jobTime; public uint flags;
        public UIntPtr minimumWorkingSet,maximumWorkingSet;
        public uint activeLimit; public UIntPtr affinity; public uint priority,scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
        public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
        public BASIC_LIMIT basic; public IO_COUNTERS io;
        public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
        public long totalUser,totalKernel,periodUser,periodKernel;
        public uint faults,total,active,terminated;
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXTENDED_LIMIT info,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out ACCOUNTING info,uint size,IntPtr returned);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool assigned);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
    IntPtr job=IntPtr.Zero, process=IntPtr.Zero, thread=IntPtr.Zero;
    static void Require(bool value) { if(!value) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    static string Quote(string value) {
        var result=new StringBuilder("\""); int slashes=0;
        foreach(char c in value) {
            if(c=='\\') { slashes++; continue; }
            if(c=='\"') { result.Append('\\',slashes*2+1); result.Append(c); }
            else { result.Append('\\',slashes); result.Append(c); }
            slashes=0;
        }
        result.Append('\\',slashes*2); return result.Append('"').ToString();
    }
    static IntPtr InheritStandard(int kind) {
        IntPtr duplicate;
        Require(DuplicateHandle(GetCurrentProcess(),GetStdHandle(kind),GetCurrentProcess(),out duplicate,0,true,2));
        return duplicate;
    }
    public OwnedStageJob(string node,string runner,string request,string directory) {
        IntPtr input=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero;
        try {
            job=CreateJobObject(IntPtr.Zero,null); Require(job!=IntPtr.Zero);
            var limits=new EXTENDED_LIMIT();
            limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE; no breakaway flags.
            Require(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))));
            input=InheritStandard(-10); output=InheritStandard(-11); error=InheritStandard(-12);
            var startup=new STARTUPINFO { cb=(uint)Marshal.SizeOf(typeof(STARTUPINFO)),flags=0x101,show=0,input=input,output=output,error=error };
            PROCESS_INFORMATION created;
            Require(CreateProcessW(node,new StringBuilder(Quote(node)+" "+Quote(runner)+" "+Quote(request)),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,directory,ref startup,out created));
            process=created.process; thread=created.thread;
            Require(AssignProcessToJobObject(job,process));
            bool assigned;
            Require(IsProcessInJob(process,job,out assigned));
            if(!assigned) throw new InvalidOperationException("Captured runner is outside its owned job");
        } catch {
            // This is the captured handle of our own still-suspended runner,
            // never a reopened or guessed PID. No stage code ran before assign.
            if(process!=IntPtr.Zero) TerminateProcess(process,1);
            Dispose(); throw;
        } finally {
            if(input!=IntPtr.Zero) CloseHandle(input);
            if(output!=IntPtr.Zero) CloseHandle(output);
            if(error!=IntPtr.Zero) CloseHandle(error);
        }
    }
    public void Start() {
        Require(ResumeThread(thread)!=0xffffffff);
        CloseHandle(thread); thread=IntPtr.Zero;
    }
    public bool RootExited() {
        uint result=WaitForSingleObject(process,0);
        if(result==0) return true;
        if(result==258) return false;
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    public bool Empty() {
        ACCOUNTING info;
        Require(QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero));
        return info.active==0;
    }
    public bool TerminateAndConfirm() {
        Require(TerminateJobObject(job,1));
        var elapsed=System.Diagnostics.Stopwatch.StartNew();
        do { if(Empty()) return true; Thread.Sleep(10); } while(elapsed.ElapsedMilliseconds<3500);
        return false;
    }
    public void Dispose() {
        if(thread!=IntPtr.Zero) { CloseHandle(thread); thread=IntPtr.Zero; }
        if(process!=IntPtr.Zero) { CloseHandle(process); process=IntPtr.Zero; }
        if(job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; }
    }
}
'@
    } finally {
        $env:TEMP = $previousTemp
        $env:TMP = $previousTmp
    }
    $job = New-Object -TypeName OwnedStageJob -ArgumentList @([string]$request.node, [string]$request.runner, $RequestFile, [string]$request.cwd)
    $started = $false
    while ($true) {
        if ($owner.HasExited) {
            $confirmed = $job.TerminateAndConfirm()
            break
        }
        if (Test-Path -LiteralPath $cancelFile) {
            $cancel = [IO.File]::ReadAllText($cancelFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
            if ($cancel.nonce -ne $request.nonce) { throw 'Invalid cancellation identity' }
            $confirmed = $job.TerminateAndConfirm()
            break
        }
        if (-not $started) { $job.Start(); $started = $true }
        if ($job.RootExited()) {
            # Check the original kernel job independently of result parsing.
            # Command failure and tree completion are separate facts.
            $confirmed = $job.Empty()
            if (-not $confirmed) { $confirmed = $job.TerminateAndConfirm() }
            if (Test-Path -LiteralPath $resultFile) {
                $result = [IO.File]::ReadAllText($resultFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
                if ($result.nonce -ne $request.nonce) { throw 'Invalid stage identity' }
                # Windows exit status is a DWORD. PowerShell's signed Int32
                # conversion throws for high-bit native exception statuses.
                # Preserve all 32 bits when passing that status to `exit`.
                # A spawn error/signal has no native integer exit status.
                if ($null -eq $result.code) { $result.code = 1 }
                if (($result.code -isnot [int] -and $result.code -isnot [long]) -or
                    $result.code -lt [int]::MinValue -or $result.code -gt [uint32]::MaxValue) {
                    throw 'Invalid native exit status'
                }
                $nativeExitCode = [long]$result.code
                if ($nativeExitCode -gt [int]::MaxValue) {
                    $exitCode = [int]($nativeExitCode - 4294967296L)
                } else { $exitCode = [int]$nativeExitCode }
                if ($result.spawnError -is [string] -and $result.spawnError -cmatch '^E[A-Z0-9_]{1,31}$') {
                    $spawnError = [string]$result.spawnError
                }
            }
            break
        }
        Start-Sleep -Milliseconds 10
    }
} catch {
    # Type-only diagnostics; user command/output never become control messages.
    [Console]::Error.WriteLine('[native-smoke] Windows CLI ownership failed: ' + $_.Exception.GetType().Name)
    $exitCode = 1
} finally {
    if ($null -ne $job) {
        try {
            # A parsing or control failure must still check/terminate our own
            # job. PID absence is never substituted for kernel accounting.
            if (-not $confirmed) { $confirmed = $job.TerminateAndConfirm() }
        } catch {
            $confirmed = $false
            $exitCode = 1
            [Console]::Error.WriteLine('[native-smoke] Windows CLI completion failed: ' + $_.Exception.GetType().Name)
        } finally { $job.Dispose() }
    }
    if ($null -ne $owner) { $owner.Dispose() }
    try {
        $proofRecord = @{ nonce = [string]$request.nonce; treeConfirmed = [bool]$confirmed }
        if ($null -ne $nativeExitCode) { $proofRecord.nativeExitCode = $nativeExitCode }
        if ($confirmed -and $null -ne $spawnError) { $proofRecord.spawnError = $spawnError }
        $proof = $proofRecord | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($receiptFile + '.tmp', $proof, (New-Object Text.UTF8Encoding $false))
        [IO.File]::Move($receiptFile + '.tmp', $receiptFile)
    } catch {
        [Console]::Error.WriteLine('[native-smoke] Windows CLI proof publication failed: ' + $_.Exception.GetType().Name)
        $exitCode = 1
    }
}
exit $exitCode
