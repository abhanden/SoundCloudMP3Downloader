"""SoundCloud MP3 Downloader & Cover-Art Extractor
yt-dlp + FFmpeg (real MP3, 320 kbps) + mutagen (ID3v2.3 + JPEG cover) + customtkinter
"""

import argparse
import queue
import re
import shutil
import threading
from io import BytesIO
from pathlib import Path
from tkinter import filedialog

import customtkinter as ctk
import requests
import yt_dlp
from mutagen.id3 import APIC, ID3, TALB, TIT2, TPE1, ID3NoHeaderError
from mutagen.mp3 import MP3
from PIL import Image

DEFAULT_DIR = Path.home() / "Music" / "SoundCloud"
COVER_SIZE = "t500x500"  # alternative: "original" (bigger, but heavier)
UA = {"User-Agent": "Mozilla/5.0"}

# matches ...-large.jpg / -t300x300.png / -original.webp etc.
SIZE_RE = re.compile(r"-(?:large|original|crop|badge|small|tiny|mini|t\d+x\d+)\.(?:jpe?g|png|webp)(?=$|\?)", re.I)


# ---------- FFmpeg ----------

def find_ffmpeg(custom=None):
    """Return (found, location). location=None -> ffmpeg is in PATH."""
    if custom:  # --ffmpeg-location: folder or ffmpeg binary
        return Path(custom).exists(), custom
    if shutil.which("ffmpeg"):
        return True, None
    local = Path(__file__).resolve().parent
    if (local / "ffmpeg.exe").exists() or (local / "ffmpeg").exists():
        return True, str(local)
    return False, None


# ---------- Cover & Tags ----------

def cover_urls(info):
    """Candidate URLs: forced hi-res first, then SoundCloud's own thumbnails (best first)."""
    raw = [t["url"] for t in info.get("thumbnails") or [] if t.get("url")]
    raw.reverse()  # yt-dlp sorts best-last
    if info.get("thumbnail"):
        raw.insert(0, info["thumbnail"])

    # Force t500x500.jpg
    hires = [SIZE_RE.sub(f"-{COVER_SIZE}.jpg", u) for u in raw]
    return list(dict.fromkeys(hires + raw))  # dedupe, keep order


def fetch_cover(info):
    """Download cover, convert to a real JPEG. Returns bytes or None."""
    for url in cover_urls(info):
        try:
            r = requests.get(url, headers=UA, timeout=15)
            r.raise_for_status()
            img = Image.open(BytesIO(r.content)).convert("RGB")  # webp/png -> RGB
            buf = BytesIO()
            img.save(buf, format="JPEG", quality=95)
            return buf.getvalue()
        except Exception:
            continue  # next candidate
    return None


def tag_mp3(path, info):
    """Write title/artist/album + JPEG cover as ID3v2.3. Returns (has_cover, kbps)."""
    try:
        tags = ID3(path)
    except ID3NoHeaderError:
        tags = ID3()

    title = info.get("title") or Path(path).stem
    artist = info.get("artist") or info.get("uploader") or "Unknown"
    tags.delall("TIT2")
    tags.delall("TPE1")
    tags.add(TIT2(encoding=3, text=title))
    tags.add(TPE1(encoding=3, text=artist))

    album = info.get("album") or info.get("playlist_title")
    if album:
        tags.delall("TALB")
        tags.add(TALB(encoding=3, text=album))

    cover = fetch_cover(info)
    if cover:
        tags.delall("APIC")
        tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=cover))

    tags.save(path, v2_version=3)  # v2.3 for Windows / Mp3tag

    # Verify: re-read file from disk
    has_cover = bool(ID3(path).getall("APIC"))
    kbps = round(MP3(path).info.bitrate / 1000)
    return has_cover, kbps


# ---------- Download worker ----------

class QLogger:
    """Route yt-dlp output into the GUI queue."""

    def __init__(self, q):
        self.q = q

    def debug(self, msg):
        if not msg.startswith("[debug]"):
            self.q.put(("log", msg))

    info = debug

    def warning(self, msg):
        self.q.put(("log", f"WARN: {msg}"))

    def error(self, msg):
        self.q.put(("log", f"ERROR: {msg}"))


def iter_entries(info):
    """Flatten playlists, skip failed (None) entries."""
    if not info:
        return
    if info.get("entries"):
        for e in info["entries"]:
            yield from iter_entries(e)
    else:
        yield info


def mp3_path_of(ydl, info):
    """Final .mp3 path of an entry (None if missing)."""
    for rd in info.get("requested_downloads") or []:
        p = rd.get("filepath")
        if p and p.lower().endswith(".mp3") and Path(p).exists():
            return p
    p = Path(ydl.prepare_filename(info)).with_suffix(".mp3")
    return str(p) if p.exists() else None


def run_download(urls, outdir, ffmpeg_dir, q):
    seen = set()
    stats = {"ok": 0, "cover": 0, "fail": 0}

    def handle(path, info):
        # Tag each MP3 exactly once
        if path in seen:
            return
        seen.add(path)
        try:
            has_cover, kbps = tag_mp3(path, info)
            stats["ok"] += 1
            stats["cover"] += has_cover
            q.put(("log", f"OK: {Path(path).name} | {kbps} kbps | cover: {'yes' if has_cover else 'NO'}"))
        except Exception as e:
            stats["fail"] += 1
            q.put(("log", f"ERROR tagging {Path(path).name}: {e}"))

    def on_progress(d):
        if d["status"] != "downloading":
            return
        total = d.get("total_bytes") or d.get("total_bytes_estimate")
        frac = d["downloaded_bytes"] / total if total else 0.0
        info = d.get("info_dict", {})
        idx = info.get("playlist_index") or 1
        n = info.get("n_entries") or 1
        q.put(("progress", ((idx - 1) + frac) / n))

    def on_pp(d):
        # Right after MP3 conversion -> tag immediately
        if d["status"] != "finished":
            return
        info = d["info_dict"]
        path = info.get("filepath")
        if path and path.lower().endswith(".mp3"):
            handle(path, info)

    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(outdir / "%(uploader)s - %(title)s.%(ext)s"),
        "postprocessors": [{
            "key": "FFmpegExtractAudio",  # force real MP3
            "preferredcodec": "mp3",
            "preferredquality": "320",
        }],
        "ignoreerrors": True,  # skip broken tracks in playlists
        "retries": 3,
        "noprogress": True,
        "logger": QLogger(q),
        "progress_hooks": [on_progress],
        "postprocessor_hooks": [on_pp],
    }
    if ffmpeg_dir:
        opts["ffmpeg_location"] = ffmpeg_dir

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            for url in urls:
                q.put(("log", f"--> {url}"))
                result = ydl.extract_info(url, download=True)

                # Safety net: tag everything the hook missed
                for entry in iter_entries(result):
                    path = mp3_path_of(ydl, entry)
                    if path:
                        handle(path, entry)
                    else:
                        stats["fail"] += 1
                        q.put(("log", f"ERROR: no MP3 for '{entry.get('title')}'"))
        q.put(("log", f"Done: {stats['ok']} MP3 | {stats['cover']} with cover | {stats['fail']} failed"))
    except Exception as e:
        q.put(("log", f"FATAL: {e}"))
    finally:
        q.put(("done", None))


# ---------- GUI ----------

class App(ctk.CTk):
    def __init__(self, ffmpeg_location=None):
        super().__init__()
        self.title("SoundCloud MP3 Downloader")
        self.geometry("780x580")
        self.minsize(640, 480)
        ctk.set_default_color_theme("blue")
        ctk.set_appearance_mode("dark")

        self.q = queue.Queue()
        self.outdir = ctk.StringVar(value=str(DEFAULT_DIR))
        self.ffmpeg_ok, self.ffmpeg_dir = find_ffmpeg(ffmpeg_location)

        self.columnconfigure(0, weight=1)
        self.rowconfigure(5, weight=1)
        self.build_ui()
        self.after(100, self.poll)

        if not self.ffmpeg_ok:
            self.log("ERROR: ffmpeg not found - MP3 conversion impossible!")
            self.log('Fix: add ffmpeg to PATH or run: python app.py --ffmpeg-location "C:\\ffmpeg\\bin"')

    def build_ui(self):
        # Header + theme switch
        head = ctk.CTkFrame(self, fg_color="transparent")
        head.grid(row=0, column=0, padx=20, pady=(16, 6), sticky="ew")
        head.columnconfigure(0, weight=1)
        ctk.CTkLabel(head, text="SoundCloud MP3 Downloader",
                     font=ctk.CTkFont(size=22, weight="bold")).grid(row=0, column=0, sticky="w")
        theme = ctk.CTkSegmentedButton(head, values=["Dark", "Light", "System"],
                                       command=ctk.set_appearance_mode)
        theme.set("Dark")
        theme.grid(row=0, column=1)

        # URL input
        self.url_entry = ctk.CTkEntry(
            self, height=38,
            placeholder_text="SoundCloud link(s): Track, Playlist, Album, Go+ (space-separated)")
        self.url_entry.grid(row=1, column=0, padx=20, pady=6, sticky="ew")

        # Target folder
        row = ctk.CTkFrame(self, fg_color="transparent")
        row.grid(row=2, column=0, padx=20, pady=6, sticky="ew")
        row.columnconfigure(0, weight=1)
        ctk.CTkEntry(row, textvariable=self.outdir, height=34).grid(row=0, column=0, sticky="ew")
        ctk.CTkButton(row, text="Browse...", width=100, command=self.pick_dir).grid(
            row=0, column=1, padx=(8, 0))

        # Start + progress
        self.btn = ctk.CTkButton(self, text="Download", height=40,
                                 font=ctk.CTkFont(size=15, weight="bold"),
                                 command=self.start)
        self.btn.grid(row=3, column=0, padx=20, pady=(8, 6), sticky="ew")
        self.bar = ctk.CTkProgressBar(self)
        self.bar.set(0)
        self.bar.grid(row=4, column=0, padx=20, pady=(4, 0), sticky="ew")

        # Log console
        self.logbox = ctk.CTkTextbox(self, state="disabled",
                                     font=ctk.CTkFont(family="Consolas", size=12))
        self.logbox.grid(row=5, column=0, padx=20, pady=(14, 20), sticky="nsew")

    def pick_dir(self):
        d = filedialog.askdirectory(initialdir=self.outdir.get() or str(Path.home()))
        if d:
            self.outdir.set(d)

    def log(self, msg):
        self.logbox.configure(state="normal")
        self.logbox.insert("end", msg + "\n")
        self.logbox.see("end")
        self.logbox.configure(state="disabled")

    def start(self):
        if not self.ffmpeg_ok:
            self.log("ERROR: Install ffmpeg first (https://ffmpeg.org) and restart.")
            return
        urls = self.url_entry.get().split()
        if not urls or not all("soundcloud.com" in u for u in urls):
            self.log("ERROR: Please enter valid SoundCloud link(s).")
            return
        outdir = Path(self.outdir.get())
        try:
            outdir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            self.log(f"ERROR: Cannot create folder: {e}")
            return

        self.btn.configure(state="disabled", text="Downloading...")
        self.bar.set(0)
        threading.Thread(target=run_download,
                         args=(urls, outdir, self.ffmpeg_dir, self.q), daemon=True).start()

    def poll(self):
        # Drain worker queue in GUI thread
        try:
            while True:
                kind, val = self.q.get_nowait()
                if kind == "log":
                    self.log(val)
                elif kind == "progress":
                    self.bar.set(min(max(val, 0.0), 1.0))
                elif kind == "done":
                    self.bar.set(1)
                    self.btn.configure(state="normal", text="Download")
        except queue.Empty:
            pass
        self.after(100, self.poll)


def main():
    parser = argparse.ArgumentParser(description="SoundCloud MP3 Downloader")
    parser.add_argument("--ffmpeg-location", metavar="PATH",
                        help="folder with ffmpeg/ffprobe (or path to the ffmpeg binary)")
    args = parser.parse_args()
    App(args.ffmpeg_location).mainloop()


if __name__ == "__main__":
    main()
