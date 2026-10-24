#!/usr/bin/env node
'use strict';

// Recovery deliberately has no age threshold, force flag or build launcher.
// The Windows transaction retains the original file and ancestor handles until
// evidence is durable and the exact held object has been marked for deletion.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { resolveRuntimeContext } = require('./runtime-context');
const { getTelemetryDir } = require('./_lib/telemetry-paths');

const MAX_LOCK_BYTES = 65536;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const outcome = (status, reason, extra = {}) => ({ status, ...(reason ? { reason } : {}), ...extra });

function safePath(projectRoot, target, { directory = false } = {}) {
    if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot) || projectRoot.includes('\0')) return false;
    const root = path.resolve(projectRoot);
    if (root === path.parse(root).root) return false;
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    if (process.platform === 'win32' && (!/^[A-Za-z]:\\/.test(root) || root.slice(2).includes(':'))) return false;
    const parsed = path.parse(target);
    let current = parsed.root;
    for (const segment of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        try {
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory())) return false;
            if (current === target && (directory ? !stat.isDirectory() : (!stat.isFile() || stat.nlink !== 1))) return false;
        } catch (error) {
            if (error.code === 'ENOENT') return true;
            return false;
        }
    }
    return true;
}

function definitelyAbsent(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return false;
    try { process.kill(pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
}

function classify(bytes) {
    let lock;
    try { lock = JSON.parse(bytes.toString('utf8')); } catch { return outcome('held', 'invalid-lock'); }
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return outcome('held', 'invalid-lock');
    if (own(lock, 'treeInProgress') || lock.terminationUnconfirmed === true) return outcome('held', 'tree-unverified');
    if ((own(lock, 'terminationUnconfirmed') && typeof lock.terminationUnconfirmed !== 'boolean') ||
        typeof lock.started !== 'string' || !Number.isFinite(Date.parse(lock.started))) return outcome('held', 'invalid-lock');
    if (!definitelyAbsent(lock.pid)) return outcome('held', 'owner-live-or-unknown');
    if (own(lock, 'childPid') && !definitelyAbsent(lock.childPid)) return outcome('held', 'child-live-or-unknown');
    // The v2 producer marks every launch before admission and returns to idle
    // only after owned-tree completion. Legacy PID absence has no such binding.
    if (lock.protocol !== 'domdhi-gate/lease-v2' || lock.phase !== 'idle') return outcome('held', 'legacy-tree-unbound');
    return outcome('recoverable', null, { ownerPid: lock.pid, ...(own(lock, 'childPid') ? { childPid: lock.childPid } : {}) });
}

function inspectGateLock({ projectRoot } = {}) {
    if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) return outcome('refused', 'unsafe-path');
    const root = path.resolve(projectRoot);
    const lockPath = path.join(getTelemetryDir(root), '.gate.lock');
    if (!safePath(root, lockPath)) return outcome('refused', 'unsafe-path');
    let fd;
    try {
        fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) return outcome('refused', 'unsafe-path');
        if (stat.size < 1 || stat.size > MAX_LOCK_BYTES) return outcome('held', 'invalid-lock');
        const bytes = fs.readFileSync(fd);
        if (bytes.length > MAX_LOCK_BYTES || !safePath(root, lockPath)) return outcome('refused', 'unsafe-path');
        return { ...classify(bytes), sha256: digest(bytes) };
    } catch (error) {
        return outcome(error.code === 'ENOENT' ? 'missing' : 'held', error.code === 'ENOENT' ? null : 'unreadable-lock');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// No paths, reasons or lock contents are interpolated into this program. Input
// is bounded JSON on stdin. Windows PowerShell supplies the inbox JSON parser;
// the native transaction owns all reads, evidence writes and retirement.
const WINDOWS_BACKEND = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$pins = New-Object 'System.Collections.Generic.List[System.IntPtr]'
$request = $null
$nativeInvoked = $false
try {
# Reflection.Emit creates only an in-memory P/Invoke type. CodeDom cannot run
# until its TEMP and every ancestor are held against rename/delete below.
$requestText = [Console]::In.ReadToEnd()
$request = ConvertFrom-Json -InputObject $requestText
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName('GateRecoveryBootstrap')), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('Bootstrap')
$builder = $module.DefineType('GateRecoveryBootstrap', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
function Define-NativeMethod($name, $returnType, [Type[]]$parameters) {
    $method = $builder.DefinePInvokeMethod($name, 'kernel32.dll', [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard, $returnType, $parameters, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
}
Define-NativeMethod 'CreateFileW' ([IntPtr]) @([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr])
Define-NativeMethod 'CreateDirectoryW' ([bool]) @([string], [IntPtr])
Define-NativeMethod 'GetFileInformationByHandleEx' ([bool]) @([IntPtr], [int], [IntPtr], [uint32])
Define-NativeMethod 'GetFinalPathNameByHandleW' ([uint32]) @([IntPtr], [Text.StringBuilder], [uint32], [uint32])
Define-NativeMethod 'CloseHandle' ([bool]) @([IntPtr])
$bootstrap = $builder.CreateType()
function Pin-Directory([string]$directory) {
    # FILE_TRAVERSE | FILE_READ_ATTRIBUTES participates in share checks without
    # requiring list permission on ancestors such as machine TEMP. Attribute-
    # only handles do not protect against rename. Deny write/delete sharing.
    $handle = $bootstrap::CreateFileW($directory, 160, 1, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
    if ($handle -eq [IntPtr](-1)) { throw 'directory-unavailable' }
    $accepted = $false
    $attributes = [Runtime.InteropServices.Marshal]::AllocHGlobal(8)
    try {
        if (-not $bootstrap::GetFileInformationByHandleEx($handle, 9, $attributes, 8)) { throw 'directory-identity-unavailable' }
        $flags = [Runtime.InteropServices.Marshal]::ReadInt32($attributes)
        if (($flags -band 0x400) -ne 0 -or ($flags -band 0x10) -eq 0) { throw 'unsafe-path' }
        $final = New-Object Text.StringBuilder(32768)
        $length = $bootstrap::GetFinalPathNameByHandleW($handle, $final, $final.Capacity, 0)
        if ($length -eq 0 -or $length -ge $final.Capacity) { throw 'directory-identity-unavailable' }
        $actual = $final.ToString()
        if ($actual.StartsWith('\\?\')) { $actual = $actual.Substring(4) }
        if (-not [string]::Equals($actual.TrimEnd('\'), $directory.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe-path' }
        $pins.Add($handle); $accepted = $true
    } finally {
        [Runtime.InteropServices.Marshal]::FreeHGlobal($attributes)
        if (-not $accepted) { [void]$bootstrap::CloseHandle($handle) }
    }
}
$root = [IO.Path]::GetFullPath([string]$request.projectRoot).TrimEnd('\')
$volume = [IO.Path]::GetPathRoot($root)
if ($volume.Length -ne 3 -or $volume[1] -ne ':' -or $root.Substring(2).Contains(':') -or (New-Object IO.DriveInfo($volume)).DriveType -ne [IO.DriveType]::Fixed) { throw 'unsupported-filesystem' }
Pin-Directory $volume
$current = $volume
foreach ($part in $root.Substring($volume.Length).Split('\')) {
    if ($part.Length -gt 0) { $current = [IO.Path]::Combine($current, $part); Pin-Directory $current }
}
if ([string]$request.operationId -notmatch '^[a-f0-9]{32}$') { throw 'invalid-operation' }
foreach ($part in @('docs', '.output', '.state', 'work', ('gate-lock-recovery-' + $request.operationId), 'compiler')) {
    $current = [IO.Path]::Combine($current, $part)
    # The parent is already held. A competing existing reparse target is opened
    # as the reparse object and rejected before any child creation or write.
    $created = $bootstrap::CreateDirectoryW($current, [IntPtr]::Zero)
    if (-not $created -and ($part -eq 'compiler' -or $part -eq ('gate-lock-recovery-' + $request.operationId))) { throw 'operation-directory-create-failed' }
    Pin-Directory $current
}
$env:TEMP = $current; $env:TMP = $current
Add-Type -ReferencedAssemblies 'System.Web.Extensions' -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public static class GateLockRecoveryNative {
    const uint Read = 0x80000000, Write = 0x40000000, Delete = 0x10000;
    const uint Reparse = 0x400, DirectoryFlag = 0x10;
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    // FILE_DISPOSITION_INFO contains BOOLEAN (one byte), not Win32 BOOL.
    [StructLayout(LayoutKind.Sequential, Pack=1)] struct Disposition { public byte DeleteFile; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint sharing, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder name, uint count, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, ref Disposition data, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 131072, RecursionLimit = 32 };
    static bool RetirementStarted;
    static Dictionary<string, object> Result(string status, string reason) {
        var r = new Dictionary<string, object>(); r["status"] = status;
        if (reason != null) r["reason"] = reason; return r;
    }
    static string Hash(byte[] bytes) { using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    static string Relative(string root, string file) { return file.Substring(root.TrimEnd('\\').Length + 1).Replace('\\', '/'); }
    static string Final(SafeFileHandle h) {
        var b = new StringBuilder(32768); uint n = GetFinalPathNameByHandle(h, b, (uint)b.Capacity, 0);
        if (n == 0 || n >= b.Capacity) throw new IOException("final-path-unavailable");
        string p = b.ToString(); if (p.StartsWith(@"\\?\")) p = p.Substring(4); return p.TrimEnd('\\');
    }
    static Info Check(SafeFileHandle h, string expected, bool directory) {
        Info i;
        if (!GetFileInformationByHandle(h, out i)) throw new IOException("file-identity-unavailable");
        if ((i.Attributes & Reparse) != 0 || ((i.Attributes & DirectoryFlag) != 0) != directory ||
            (!directory && i.Links != 1) || !String.Equals(Final(h), expected.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            throw new IOException("unsafe-path");
        return i;
    }
    static void PinDirectory(string dir, List<SafeFileHandle> held) {
        // FILE_TRAVERSE | FILE_READ_ATTRIBUTES: traversal participates in share
        // enforcement without requiring ancestor directory-list permission.
        var h = CreateFile(dir, 0xA0, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (h.IsInvalid) { h.Dispose(); throw new IOException("directory-unavailable"); }
        try { Check(h, dir, true); held.Add(h); } catch { h.Dispose(); throw; }
    }
    static void PinChain(string dir, List<SafeFileHandle> held) {
        string volume = Path.GetPathRoot(dir);
        if (volume.Length != 3 || volume[1] != ':' || dir.Substring(2).Contains(":")) throw new IOException("unsafe-path");
        if (new DriveInfo(volume).DriveType != DriveType.Fixed) throw new IOException("unsupported-filesystem");
        PinDirectory(volume, held); string current = volume;
        foreach (string part in dir.Substring(volume.Length).Split('\\')) {
            if (part.Length == 0) continue;
            current = Path.Combine(current, part); PinDirectory(current, held);
        }
    }
    static bool Pid(object value, out uint pid) {
        pid = 0;
        if (!(value is int) && !(value is long)) return false;
        long n = Convert.ToInt64(value); if (n <= 0 || n > Int32.MaxValue) return false;
        pid = (uint)n; return true;
    }
    static bool Absent(object value) {
        uint pid; if (!Pid(value, out pid)) return false;
        IntPtr h = OpenProcess(0x100000 | 0x1000, false, pid);
        if (h == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87;
        try { return WaitForSingleObject(h, 0) == 0; } finally { CloseHandle(h); }
    }
    static string Validate(Dictionary<string, object> state) {
        if (state == null) return "invalid-lock";
        if (state.ContainsKey("treeInProgress") || (state.ContainsKey("terminationUnconfirmed") && state["terminationUnconfirmed"] is bool && (bool)state["terminationUnconfirmed"])) return "tree-unverified";
        if (state.ContainsKey("terminationUnconfirmed") && !(state["terminationUnconfirmed"] is bool)) return "invalid-lock";
        object started; DateTimeOffset when;
        if (!state.TryGetValue("started", out started) || !(started is string) || !DateTimeOffset.TryParse((string)started, out when)) return "invalid-lock";
        object pid; if (!state.TryGetValue("pid", out pid) || !Absent(pid)) return "owner-live-or-unknown";
        if (state.ContainsKey("childPid") && !Absent(state["childPid"])) return "child-live-or-unknown";
        object protocol, phase;
        if (!state.TryGetValue("protocol", out protocol) || !(protocol is string) || (string)protocol != "domdhi-gate/lease-v2" ||
            !state.TryGetValue("phase", out phase) || !(phase is string) || (string)phase != "idle") return "legacy-tree-unbound";
        return null;
    }
    static FileStream NewEvidence(string file) {
        var h = CreateFile(file, Write | Read, 0, IntPtr.Zero, 1, 0x00200000, IntPtr.Zero);
        if (h.IsInvalid) { h.Dispose(); throw new IOException("archive-create-failed"); }
        try { Check(h, file, false); return new FileStream(h, FileAccess.ReadWrite); } catch { h.Dispose(); throw; }
    }
    static void WriteFlush(FileStream stream, byte[] bytes) {
        stream.Position = 0; stream.Write(bytes, 0, bytes.Length); stream.SetLength(bytes.Length); stream.Flush(true);
        stream.Position = 0; byte[] actual = new byte[bytes.Length]; int count = 0, read;
        while (count < actual.Length && (read = stream.Read(actual, count, actual.Length - count)) > 0) count += read;
        if (count != actual.Length || Hash(actual) != Hash(bytes)) throw new IOException("archive-verification-failed");
    }
    static byte[] Encode(object value) { return new UTF8Encoding(false, true).GetBytes(Json.Serialize(value)); }
    static Dictionary<string, object> Recover(Dictionary<string, object> input) {
        string root = Path.GetFullPath((string)input["projectRoot"]).TrimEnd('\\');
        string file = Path.Combine(root, @"docs\.output\.state\telemetry\.gate.lock");
        string expected = (string)input["expectedSha256"], reason = (string)input["reason"];
        var held = new List<SafeFileHandle>();
        try {
            PinChain(Path.GetDirectoryName(file), held);
            var handle = CreateFile(file, Read | Delete, 0, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error(); handle.Dispose();
                return Result(error == 2 ? "missing" : "held", error == 2 ? null : "exclusive-open-failed");
            }
            using (handle) using (var original = new FileStream(handle, FileAccess.Read)) {
                Info id = Check(handle, file, false);
                long length = ((long)id.SizeHigh << 32) | id.SizeLow;
                if (length < 1 || length > 65536) return Result("held", "invalid-lock");
                byte[] bytes = new byte[(int)length]; int count = 0, read;
                while (count < bytes.Length && (read = original.Read(bytes, count, bytes.Length - count)) > 0) count += read;
                if (count != bytes.Length) return Result("held", "unreadable-lock");
                string sha = Hash(bytes);
                if (sha != expected) { var changed = Result("changed", "digest-mismatch"); changed["sha256"] = sha; return changed; }
                Dictionary<string, object> state;
                try { state = Json.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(bytes)); }
                catch { return Result("held", "invalid-lock"); }
                string invalid = Validate(state); if (invalid != null) return Result("held", invalid);
                // Bootstrap created and pinned this operation before CodeDom.
                string operationId = (string)input["operationId"];
                if (operationId.Length != 32 || !System.Text.RegularExpressions.Regex.IsMatch(operationId, "^[a-f0-9]{32}$")) throw new IOException("invalid-operation");
                string operation = Path.Combine(root, @"docs\.output\.state\work", "gate-lock-recovery-" + operationId);
                PinChain(operation, held);
                string archive = Path.Combine(operation, "original.gate.lock"), receipt = Path.Combine(operation, "receipt.json");
                string completion = Path.Combine(operation, "completion.json");
                var record = Result("prepared", null);
                record["protocol"] = "gate-lock-recovery/windows-held-handle-v1";
                record["operationId"] = operationId;
                record["originalSha256"] = sha; record["reason"] = reason;
                record["originalPath"] = Relative(root, file); record["archive"] = Relative(root, archive);
                record["ownerPid"] = state["pid"]; if (state.ContainsKey("childPid")) record["childPid"] = state["childPid"];
                record["ownerAbsent"] = true; record["recordedChildAbsent"] = true; record["treeMarkersAbsent"] = true;
                record["volume"] = id.Volume; record["fileIndexHigh"] = id.IndexHigh; record["fileIndexLow"] = id.IndexLow;
                record["byteLength"] = bytes.Length; record["preparedAt"] = DateTimeOffset.UtcNow.ToString("o");
                using (var saved = NewEvidence(archive)) using (var journal = NewEvidence(receipt)) {
                    WriteFlush(saved, bytes); WriteFlush(journal, Encode(record));
                    invalid = Validate(state); if (invalid != null) return Result("held", invalid);
                    Check(handle, file, false);
                    var disposition = new Disposition { DeleteFile = 1 };
                    if (!SetFileInformationByHandle(handle, 4, ref disposition, (uint)Marshal.SizeOf(typeof(Disposition))))
                        return Result("held", "handle-retirement-failed");
                    RetirementStarted = true;
                    // Close only after successful disposition: there is no
                    // path-based unlink or rename that could hit a successor.
                    original.Dispose(); handle.Dispose();
                    // The valid prepared record is immutable. A failed or partial
                    // completion file cannot destroy the pre-retirement proof.
                    var finished = Result("recovered", null);
                    finished["operationId"] = operationId; finished["originalSha256"] = sha;
                    finished["preparedReceipt"] = Relative(root, receipt);
                    finished["completedAt"] = DateTimeOffset.UtcNow.ToString("o");
                    using (var completed = NewEvidence(completion)) WriteFlush(completed, Encode(finished));
                }
                var result = Result("recovered", null); result["sha256"] = sha;
                result["archive"] = Relative(root, archive); result["receipt"] = Relative(root, receipt);
                result["completion"] = Relative(root, completion); return result;
            }
        } finally { for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose(); }
    }
    public static string Run(string source) {
        Dictionary<string, object> input = null, result;
        RetirementStarted = false;
        try { input = Json.Deserialize<Dictionary<string, object>>(source); result = Recover(input); }
        catch (Exception error) {
            result = Result(RetirementStarted ? "retired-uncertain" : "refused", "native-transaction-failed");
            result["errorType"] = error.GetType().Name;
        }
        if (input != null) {
            string operationId = (string)input["operationId"];
            string operation = "docs/.output/.state/work/gate-lock-recovery-" + operationId;
            result["operationId"] = operationId; result["operation"] = operation;
            result["archive"] = operation + "/original.gate.lock"; result["receipt"] = operation + "/receipt.json";
            result["completion"] = operation + "/completion.json"; result["compilerScratch"] = operation + "/compiler";
            result["sha256"] = input["expectedSha256"];
        }
        return Json.Serialize(result);
    }
}
'@
$nativeInvoked = $true
[Console]::Out.WriteLine([GateLockRecoveryNative]::Run($requestText))
} catch {
    # Once native execution begins, a lost reply cannot assert no retirement.
    $failed = @{ status = $(if ($nativeInvoked) { 'retirement-uncertain' } else { 'refused' }); reason = 'native-backend-unavailable'; operationId = $request.operationId; errorType = $_.Exception.GetType().Name }
    [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject $failed))
} finally {
    for ($index = $pins.Count - 1; $index -ge 0; $index--) { [void]$bootstrap::CloseHandle($pins[$index]) }
}
`;

function recoverGateLock({ projectRoot, expectedSha256, reason } = {}) {
    if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256) ||
        typeof reason !== 'string' || reason.trim().length < 1 || reason.length > 2048 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(reason))
        return outcome('refused', 'invalid-arguments');
    const inspected = inspectGateLock({ projectRoot });
    if (inspected.sha256 && inspected.sha256 !== expectedSha256) return outcome('changed', 'digest-mismatch', { sha256: inspected.sha256 });
    if (inspected.status !== 'recoverable') return inspected;
    if (process.platform !== 'win32') return outcome('refused', 'unsupported-platform');
    // Allocate identity without touching the filesystem. It lets callers locate
    // evidence after a timeout/lost reply without scanning GUID directories or
    // retrying retirement against a successor lock.
    const operationId = crypto.randomBytes(16).toString('hex');
    const operation = `docs/.output/.state/work/gate-lock-recovery-${operationId}`;
    const operationState = {
        operationId, operation, sha256: expectedSha256,
        archive: `${operation}/original.gate.lock`, receipt: `${operation}/receipt.json`,
        completion: `${operation}/completion.json`, compilerScratch: `${operation}/compiler`,
    };
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let result;
    try {
        result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_BACKEND], {
            input: JSON.stringify({ projectRoot: path.resolve(projectRoot), expectedSha256, reason, operationId }),
            encoding: 'utf8', windowsHide: true, timeout: 25000, maxBuffer: 65536,
            env: { ...process.env },
        });
    } catch { return outcome('retirement-uncertain', 'native-backend-failed', operationState); }
    // Retain this operation's private compiler artifacts, particularly on any
    // failure. Diagnostics identify their local path without dumping stderr.
    if (result.error || result.status !== 0) return outcome('retirement-uncertain', 'native-backend-failed', operationState);
    try {
        const value = JSON.parse(result.stdout.trim());
        if (!value || !['missing', 'held', 'changed', 'refused', 'recovered', 'retired-uncertain', 'retirement-uncertain'].includes(value.status) ||
            value.operationId !== operationId) return outcome('retirement-uncertain', 'invalid-native-result', operationState);
        return { ...value, ...operationState };
    } catch { return outcome('retirement-uncertain', 'invalid-native-result', operationState); }
}

function cli(args) {
    const [command, ...flags] = args;
    if (!['inspect', 'recover'].includes(command)) return outcome('refused', 'invalid-arguments');
    const values = {};
    for (let i = 0; i < flags.length; i += 2) {
        const flag = flags[i];
        if (command !== 'recover' || !['--expected-sha256', '--reason'].includes(flag) || own(values, flag) || typeof flags[i + 1] !== 'string')
            return outcome('refused', 'invalid-arguments');
        values[flag] = flags[i + 1];
    }
    const { projectRoot } = resolveRuntimeContext();
    return command === 'inspect' ? inspectGateLock({ projectRoot }) : recoverGateLock({
        projectRoot, expectedSha256: values['--expected-sha256'], reason: values['--reason'],
    });
}

if (require.main === module) {
    let result;
    try { result = cli(process.argv.slice(2)); } catch { result = outcome('refused', 'runtime-context-unavailable'); }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = ['missing', 'recoverable', 'recovered'].includes(result.status) ? 0 : 1;
}

module.exports = { inspectGateLock, recoverGateLock };
