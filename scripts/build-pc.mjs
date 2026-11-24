import fs from "node:fs";
import path from "node:path";
import { build as esbuild } from "esbuild";

const rootDir = process.cwd();
const distDir = path.resolve(rootDir, "dist");
const outDir = path.resolve(rootDir, "release", "PANDAFACE-PC");

if (!fs.existsSync(path.join(distDir, "index.html"))) {
  console.error("Missing dist/index.html. Run 'npm run build' first.");
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await esbuild({
  entryPoints: [path.resolve(rootDir, "server.ts")],
  outfile: path.resolve(outDir, "server.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  minify: true,
  external: ["vite"],
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
  "where node >nul 2>&1",
  "if errorlevel 1 (",
  "  echo [ERROR] No se encontro Node.js en este PC.",
  "  echo Instala Node.js LTS desde https://nodejs.org o ejecuta Crear-PANDAFACE-EXE.bat",
  "  pause",
  "  exit /b 1",
  ")",
  "",
  "if not exist \".env\" (",
  "  if exist \".env.example\" copy /y \".env.example\" \".env\" >nul",
  ")",
  "",
  "echo Iniciando PANDAFACE en http://localhost:3000 ...",
  "node \"%~dp0server.cjs\" --open",
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

console.log(`PC bundle created at ${outDir}`);
