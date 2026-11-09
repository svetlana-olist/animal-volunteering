"""Create a labelled contact sheet for visual review, without changing originals.

Usage: python scripts/review-media.py animals/cats/<name>
Requires OpenCV; writes only to the system temporary directory.
"""

import argparse
import math
from pathlib import Path
import tempfile

import cv2
import numpy as np


def contact_sheet(directory):
    directory = Path(directory).resolve()
    extensions = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".mov", ".webm"}
    media = sorted(p for p in directory.iterdir() if p.suffix.lower() in extensions)
    if not media:
        raise ValueError("No media found")
    tiles = []
    for index, file in enumerate(media, 1):
        if not file.name.startswith(directory.name + "-") or file.is_symlink():
            raise ValueError(f"Invalid media path: {file}")
        frames = []
        if file.suffix.lower() in {".mp4", ".mov", ".webm"}:
            video = cv2.VideoCapture(str(file))
            try:
                count = int(video.get(cv2.CAP_PROP_FRAME_COUNT))
                if count <= 0:
                    raise ValueError(f"Cannot decode video: {file}")
                for position in np.linspace(0, count - 1, min(6, count), dtype=int):
                    video.set(cv2.CAP_PROP_POS_FRAMES, int(position))
                    ok, frame = video.read()
                    if not ok:
                        raise ValueError(f"Cannot decode frame {position}: {file}")
                    frames.append((frame, f"media {index} / frame {position}"))
            finally:
                video.release()
        else:
            image = cv2.imdecode(np.fromfile(file, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                raise ValueError(f"Cannot decode image: {file}")
            frames.append((image, f"media {index}"))
        print(f"{index}: {file.name}")
        for frame, label in frames:
            height, width = frame.shape[:2]
            scale = min(480 / width, 400 / height)
            resized = cv2.resize(frame, (max(1, round(width * scale)), max(1, round(height * scale))))
            tile = np.full((430, 480, 3), 245, dtype=np.uint8)
            h, w = resized.shape[:2]
            tile[:h, (480 - w) // 2:(480 - w) // 2 + w] = resized
            cv2.putText(tile, label, (12, 420), cv2.FONT_HERSHEY_SIMPLEX, .6, (0, 0, 0), 1)
            tiles.append(tile)
    columns = min(3, len(tiles))
    sheet = np.full((math.ceil(len(tiles) / columns) * 430, columns * 480, 3), 245, dtype=np.uint8)
    for index, tile in enumerate(tiles):
        row, column = divmod(index, columns)
        sheet[row * 430:(row + 1) * 430, column * 480:(column + 1) * 480] = tile
    output = Path(tempfile.gettempdir()) / f"animal-review-{directory.name}.jpg"
    ok, encoded = cv2.imencode(".jpg", sheet)
    if not ok:
        raise ValueError("Cannot encode contact sheet")
    encoded.tofile(output)
    print(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory")
    contact_sheet(parser.parse_args().directory)
