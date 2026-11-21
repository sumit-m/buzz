/**
 * LOCAL DIVERGENCE: repository videos in the Files tab. A tile's thumbnail is
 * the video's first frame, drawn in the webview from a `buzz-repo` URL, so
 * only the header and first frame are read; at most two at a time.
 */

import { createUploadLimiter } from "@/features/messages/lib/uploadLimiter";
import type { ProjectRepoThumbnail } from "@/shared/api/projectGit";

const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  m4v: "video/mp4",
  mov: "video/quicktime",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** The longest thumbnail edge, as the desktop makes image thumbnails. */
const THUMBNAIL_EDGE = 480;
const CAPTURE_TIMEOUT_MS = 20_000;
const limitCaptures = createUploadLimiter(2);

export function videoMimeForPath(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return path.includes(".")
    ? (VIDEO_MIME_BY_EXTENSION[extension] ?? null)
    : null;
}

/** The first frame of the video at `url` as a JPEG thumbnail, or null. */
export function captureFirstFrame(
  path: string,
  url: string,
): Promise<ProjectRepoThumbnail | null> {
  return limitCaptures(
    () =>
      new Promise<ProjectRepoThumbnail | null>((resolve) => {
        const video = document.createElement("video");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (thumbnail: ProjectRepoThumbnail | null) => {
          clearTimeout(timer);
          video.removeAttribute("src");
          video.load();
          resolve(thumbnail);
        };
        timer = setTimeout(() => finish(null), CAPTURE_TIMEOUT_MS);
        video.crossOrigin = "anonymous";
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        video.addEventListener("error", () => finish(null), { once: true });
        video.addEventListener(
          "loadeddata",
          () => {
            // A frame just past the start, which some encoders leave black.
            video.currentTime = Math.min(0.1, (video.duration || 0.2) / 2);
          },
          { once: true },
        );
        video.addEventListener(
          "seeked",
          () => {
            const { videoWidth: width, videoHeight: height } = video;
            if (!width || !height) return finish(null);
            const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(width, height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(width * scale);
            canvas.height = Math.round(height * scale);
            const context = canvas.getContext("2d");
            if (!context) return finish(null);
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            try {
              finish({
                path,
                width,
                height,
                dataUrl: canvas.toDataURL("image/jpeg", 0.8),
              });
            } catch {
              finish(null);
            }
          },
          { once: true },
        );
        video.src = url;
      }),
  );
}
