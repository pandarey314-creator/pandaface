import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { build as esbuild } from "esbuild";
import { exec as pkgExec } from "@yao-pkg/pkg";

const rootDir = process.cwd();
const distDir = path.resolve(rootDir, "dist");
const outDir = path.resolve(rootDir, "release", "PANDAFACE-PC");
const zipOutPath = path.resolve(rootDir, "release", "PANDAFACE-PC.zip");
const exeOutPath = path.resolve(rootDir, "release", "PANDAFACE.exe");

if (!fs.existsSync(path.join(distDir, "index.html"))) {
  console.error("Missing dist/index.html. Run 'npm run build' first.");
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const stubVitePlugin = {
  name: "stub-vite",
  setup(build) {
    build.onResolve({ filter: /^vite$/ }, () => ({
      path: "vite",
      namespace: "stub-vite",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub-vite" }, () => ({
      contents:
        'export async function createServer() { throw new Error("Production build"); }',
      loader: "js",
    }));
  },
};

await esbuild({
  entryPoints: [path.resolve(rootDir, "server.ts")],
  outfile: path.resolve(outDir, "server.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  minify: true,
  plugins: [stubVitePlugin],
  logLevel: "info",
});

fs.cpSync(distDir, path.resolve(outDir, "dist"), {
  recursive: true,
  force: true,
});

const connectBatSrc = path.resolve(rootDir, "public", "scripts", "connect.bat");
if (fs.existsSync(connectBatSrc)) {
  const connectBatDest = path.resolve(outDir, "public", "scripts", "connect.bat");
  fs.mkdirSync(path.dirname(connectBatDest), { recursive: true });
  fs.copyFileSync(connectBatSrc, connectBatDest);
  fs.copyFileSync(connectBatSrc, path.resolve(outDir, "connect.bat"));
}

const envExample = [
  "PORT=3000",
  "DECART_API_KEY=",
  "DECART_API_KEY_2=",
  "DECART_API_KEY_3=",
  "",
].join("\r\n");
fs.writeFileSync(path.resolve(outDir, ".env.example"), envExample, "utf8");

const pandafaceBat = [
  "@echo off",
  "setlocal",
  "cd /d \"%~dp0\"",
  "title PANDAFACE PC",
  "set NODE_ENV=production",
  "set PANDAFACE_PORTABLE=1",
  "set PANDAFACE_OPEN_BROWSER=1",
  "",
  "set \"NODE_EXE=\"",
  "for /f \"delims=\" %%I in ('where node 2^>nul') do if not defined NODE_EXE set \"NODE_EXE=%%I\"",
  "if not defined NODE_EXE if exist \"%LOCALAPPDATA%\\PANDAFACE\\runtime\\node.exe\" set \"NODE_EXE=%LOCALAPPDATA%\\PANDAFACE\\runtime\\node.exe\"",
  "if not defined NODE_EXE if exist \"%~dp0runtime\\node.exe\" set \"NODE_EXE=%~dp0runtime\\node.exe\"",
  "",
  "if not defined NODE_EXE (",
  "  echo Preparando entorno Node.js portable para PANDAFACE...",
  "  powershell -NoProfile -ExecutionPolicy Bypass -Command \"$rt = Join-Path $env:LOCALAPPDATA 'PANDAFACE\\runtime'; New-Item -ItemType Directory -Force -Path $rt | Out-Null; $zip = Join-Path $env:TEMP 'node-win-x64.zip'; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.21.1/node-v22.21.1-win-x64.zip' -OutFile $zip -UseBasicParsing; $ext = Join-Path $env:TEMP 'node-win-ext'; Remove-Item $ext -Recurse -Force -ErrorAction SilentlyContinue; Expand-Archive -Path $zip -DestinationPath $ext -Force; $sub = Get-ChildItem $ext -Directory | Select-Object -First 1; Copy-Item (Join-Path $sub.FullName 'node.exe') (Join-Path $rt 'node.exe') -Force\"",
  "  if exist \"%LOCALAPPDATA%\\PANDAFACE\\runtime\\node.exe\" set \"NODE_EXE=%LOCALAPPDATA%\\PANDAFACE\\runtime\\node.exe\"",
  ")",
  "",
  "if not defined NODE_EXE (",
  "  echo [ERROR] No se pudo preparar Node.js automaticamente.",
  "  echo Descarga directamente PANDAFACE.exe desde el boton Instalar PC ^(.exe^).",
  "  pause",
  "  exit /b 1",
  ")",
  "",
  "if not exist \".env\" (",
  "  if exist \".env.example\" copy /y \".env.example\" \".env\" >nul",
  ")",
  "",
  "echo Iniciando PANDAFACE en http://localhost:3000 ...",
  "\"%NODE_EXE%\" \"%~dp0server.cjs\" --open",
  "if errorlevel 1 pause",
  "",
].join("\r\n");
fs.writeFileSync(path.resolve(outDir, "PANDAFACE.bat"), pandafaceBat, "utf8");

const launcherCs = `using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Threading;

class PandafaceLauncher {
    [STAThread]
    static int Main(string[] args) {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string serverJs = Path.Combine(baseDir, "server.cjs");
        string url = "http://localhost:3000";

        if (!File.Exists(serverJs)) {
            Console.WriteLine("No se encontro server.cjs junto a PANDAFACE.exe");
            return 1;
        }

        string envFile = Path.Combine(baseDir, ".env");
        string envExample = Path.Combine(baseDir, ".env.example");
        if (!File.Exists(envFile) && File.Exists(envExample)) {
            File.Copy(envExample, envFile);
        }

        Process serverProc = null;
        if (!IsServerAlive(url)) {
            var psi = new ProcessStartInfo("node", "\\"" + serverJs + "\\"") {
                WorkingDirectory = baseDir,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            psi.EnvironmentVariables["NODE_ENV"] = "production";
            psi.EnvironmentVariables["PANDAFACE_PORTABLE"] = "1";
            serverProc = Process.Start(psi);

            for (int i = 0; i < 40; i++) {
                if (IsServerAlive(url)) break;
                Thread.Sleep(250);
            }
        }

        Process browserProc = LaunchAppWindow(url);
        if (browserProc != null) {
            browserProc.WaitForExit();
        } else if (serverProc != null) {
            serverProc.WaitForExit();
        }

        if (serverProc != null && !serverProc.HasExited) {
            try { serverProc.Kill(); } catch {}
        }
        return 0;
    }

    static bool IsServerAlive(string baseUrl) {
        try {
            using (var client = new HttpClient()) {
                client.Timeout = TimeSpan.FromMilliseconds(450);
                var resp = client.GetAsync(baseUrl + "/api/health").GetAwaiter().GetResult();
                return resp.IsSuccessStatusCode;
            }
        } catch {
            return false;
        }
    }

    static Process LaunchAppWindow(string url) {
        string profileDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "PANDAFACE",
            "AppProfile"
        );
        Directory.CreateDirectory(profileDir);
        string[] candidates = new string[] {
            @"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
            @"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
            @"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        };
        foreach (string bin in candidates) {
            if (File.Exists(bin)) {
                return Process.Start(new ProcessStartInfo(
                    bin,
                    "--app=" + url + " --new-window --user-data-dir=\\"" + profileDir + "\\""
                ) {
                    UseShellExecute = false
                });
            }
        }
        return Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}
`;
fs.writeFileSync(
  path.resolve(outDir, "PandafaceLauncher.cs"),
  launcherCs,
  "utf8"
);

const buildExeBat = [
  "@echo off",
  "setlocal",
  "cd /d \"%~dp0\"",
  "title Generador PANDAFACE.exe",
  "echo ======================================================",
  "echo   Generador de PANDAFACE.exe para Windows",
  "echo ======================================================",
  "echo.",
  "echo [1/2] Compilando PANDAFACE.exe nativo con .NET Framework...",
  "set \"CSC=%WINDIR%\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe\"",
  "if not exist \"%CSC%\" set \"CSC=%WINDIR%\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe\"",
  "if exist \"%CSC%\" (",
  "  \"%CSC%\" /nologo /target:winexe /out:\"PANDAFACE.exe\" /r:System.Net.Http.dll \"PandafaceLauncher.cs\"",
  "  if not errorlevel 1 (",
  "    echo [OK] PANDAFACE.exe generado correctamente en:",
  "    echo      %~dp0PANDAFACE.exe",
  "  ) else (",
  "    echo [ERROR] Fallo compilando con csc.exe",
  "  )",
  ") else (",
  "  echo [AVISO] No se encontro csc.exe en este equipo.",
  ")",
  "echo.",
  "echo [2/2] Opcional: generar ejecutable 100%% autonomo sin Node.js (PANDAFACE-Standalone.exe)",
  "where npx >nul 2>&1",
  "if not errorlevel 1 (",
  "  choice /M \"Deseas empaquetar tambien PANDAFACE-Standalone.exe (~70MB, no requiere Node.js)?\"",
  "  if errorlevel 2 goto done",
  "  npx --yes @yao-pkg/pkg server.cjs --targets node20-win-x64 --output PANDAFACE-Standalone.exe",
  ")",
  ":done",
  "echo.",
  "echo Listo. Ejecuta PANDAFACE.exe para abrir la aplicacion.",
  "pause",
  "",
].join("\r\n");
fs.writeFileSync(
  path.resolve(outDir, "Crear-PANDAFACE-EXE.bat"),
  buildExeBat,
  "utf8"
);

const installBat = [
  "@echo off",
  "setlocal",
  "cd /d \"%~dp0\"",
  "title Instalador PANDAFACE PC",
  "echo ======================================================",
  "echo   Instalando PANDAFACE en este PC",
  "echo ======================================================",
  "echo.",
  "set \"INSTALL_DIR=%LOCALAPPDATA%\\PANDAFACE\"",
  "echo [1/4] Copiando archivos en \"%INSTALL_DIR%\" ...",
  "if not exist \"%INSTALL_DIR%\" mkdir \"%INSTALL_DIR%\"",
  "robocopy \"%~dp0.\" \"%INSTALL_DIR%\" /E /NFL /NDL /NJH /NJS /NC /NS /XF .env >nul",
  "if not exist \"%INSTALL_DIR%\\.env\" (",
  "  if exist \"%INSTALL_DIR%\\.env.example\" copy /y \"%INSTALL_DIR%\\.env.example\" \"%INSTALL_DIR%\\.env\" >nul",
  ")",
  "echo [2/4] Compilando PANDAFACE.exe nativo ...",
  "set \"TARGET_EXE=%INSTALL_DIR%\\PANDAFACE.bat\"",
  "set \"CSC=%WINDIR%\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe\"",
  "if not exist \"%CSC%\" set \"CSC=%WINDIR%\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe\"",
  "if exist \"%CSC%\" (",
  "  pushd \"%INSTALL_DIR%\"",
  "  \"%CSC%\" /nologo /target:winexe /out:\"PANDAFACE.exe\" /r:System.Net.Http.dll \"PandafaceLauncher.cs\"",
  "  if not errorlevel 1 set \"TARGET_EXE=%INSTALL_DIR%\\PANDAFACE.exe\"",
  "  popd",
  ")",
  "echo [3/4] Creando acceso directo en el Escritorio y Menu Inicio ...",
  "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$ws = New-Object -ComObject WScript.Shell; $d = [Environment]::GetFolderPath('Desktop'); $s = $ws.CreateShortcut((Join-Path $d 'PANDAFACE.lnk')); $s.TargetPath = '%TARGET_EXE%'; $s.WorkingDirectory = '%INSTALL_DIR%'; $s.Save(); $sm = Join-Path ([Environment]::GetFolderPath('Programs')) 'PANDAFACE.lnk'; $s2 = $ws.CreateShortcut($sm); $s2.TargetPath = '%TARGET_EXE%'; $s2.WorkingDirectory = '%INSTALL_DIR%'; $s2.Save()\"",
  "echo [4/4] Iniciando PANDAFACE ...",
  "start \"\" \"%TARGET_EXE%\"",
  "echo.",
  "echo Instalacion completada en: %INSTALL_DIR%",
  "timeout /t 3 /nobreak >nul",
  "",
].join("\r\n");
fs.writeFileSync(
  path.resolve(outDir, "Instalar-PANDAFACE.bat"),
  installBat,
  "utf8"
);

// Build deterministic ZIP archive (PANDAFACE-PC.zip) using built-in node:zlib
function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function collectFiles(dir, basePrefix = "PANDAFACE-PC") {
  const entries = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === ".env") continue; // Never package real secrets
    const full = path.join(dir, name);
    const rel = `${basePrefix}/${name}`;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      entries.push(...collectFiles(full, rel));
    } else if (stat.isFile()) {
      entries.push({ full, rel, stat });
    }
  }
  return entries;
}

function createZip(sourceDir, outZip) {
  const files = collectFiles(sourceDir);
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const { full, rel, stat } of files) {
    const raw = fs.readFileSync(full);
    const compressed = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const nameBuf = Buffer.from(rel.replace(/\\/g, "/"), "utf8");

    const dt = stat.mtime;
    const dosTime =
      ((dt.getHours() & 0x1f) << 11) |
      ((dt.getMinutes() & 0x3f) << 5) |
      ((dt.getSeconds() >> 1) & 0x1f);
    const dosDate =
      (((Math.max(1980, dt.getFullYear()) - 1980) & 0x7f) << 9) |
      (((dt.getMonth() + 1) & 0x0f) << 5) |
      (dt.getDate() & 0x1f);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localChunks.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralChunks.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralChunks);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralBuf.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  fs.writeFileSync(
    outZip,
    Buffer.concat([...localChunks, centralBuf, endRecord])
  );
  return files.length;
}

const pkgManifest = {
  name: "pandaface-pc",
  version: "1.0.0",
  private: true,
  bin: "server.cjs",
  pkg: {
    assets: ["dist/**/*", "public/**/*", ".env.example"],
  },
};
const pkgManifestPath = path.resolve(outDir, "package.json");
fs.writeFileSync(
  pkgManifestPath,
  JSON.stringify(pkgManifest, null, 2),
  "utf8"
);

const zipCount = createZip(outDir, zipOutPath);
console.log(
  `PC bundle created at ${outDir} and zipped (${zipCount} files) to ${zipOutPath}`
);

await pkgExec([
  pkgManifestPath,
  "--targets",
  "node22-win-x64",
  "--output",
  exeOutPath,
  "--no-bytecode",
  "--public",
  "--public-packages",
  "*",
  "--compress",
  "GZip",
]);
console.log(`Standalone Windows executable created at ${exeOutPath}`);
