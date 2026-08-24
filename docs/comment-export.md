# Export comments to an NLE

FreeFrame can export a version's timecoded comments as timeline markers for DaVinci Resolve, Final Cut Pro, and Adobe Premiere Pro. It can also export comments as CSV for a spreadsheet or archive.

## Export a version's comments

1. Open the asset and select the version whose comments you want to export.
2. In the comment panel toolbar, select **Export comments**.
3. Choose the format for your destination:

   | Destination | FreeFrame export |
   |-------------|------------------|
   | DaVinci Resolve | **DaVinci Resolve (EDL)** |
   | Final Cut Pro | **Final Cut Pro (FCPXML)** |
   | Adobe Premiere Pro | **Premiere Pro (XML)** |
   | Spreadsheet or archive | **CSV** |

4. If FreeFrame asks for a frame rate, choose the original frame rate of the uploaded video. Newly uploaded videos normally have this metadata stored and skip the prompt.
5. Import the downloaded marker file into the matching editing application.

EDL, FCPXML, and Premiere XML exports are available for video assets. Use CSV for image or audio assets.

## Keep markers aligned

- Export comments from the exact version that matches the edit in your timeline.
- When prompted, use the source video's original frame rate. Choosing a different rate can shift markers away from the reviewed frame.
- In DaVinci Resolve, keep the timeline start timecode aligned with the exported EDL. FreeFrame uses `01:00:00:00` as the default start timecode.
- Variable-frame-rate source video can place a marker up to one frame away from the expected position.

## Troubleshooting

### The markers drift over time

Export again and select the video's original frame rate. A frame-rate mismatch causes the marker offset to grow over the duration of the video.

### The markers do not match the current cut

Confirm that the selected FreeFrame version is the same cut loaded in the editing application. Comments are exported relative to the reviewed version.

### An NLE export is not available

The NLE formats are shown only for video assets. Choose CSV when reviewing an image or audio asset.
