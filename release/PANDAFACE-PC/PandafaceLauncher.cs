using System;
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
            var psi = new ProcessStartInfo("node", "\"" + serverJs + "\"") {
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
            @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            @"C:\Program Files\Google\Chrome\Application\chrome.exe"
        };
        foreach (string bin in candidates) {
            if (File.Exists(bin)) {
                return Process.Start(new ProcessStartInfo(
                    bin,
                    "--app=" + url + " --new-window --user-data-dir=\"" + profileDir + "\""
                ) {
                    UseShellExecute = false
                });
            }
        }
        return Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}
