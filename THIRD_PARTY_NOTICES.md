# Third-party notices

## NVIDIA SoL-Pi

Source: https://github.com/NVlabs/SoL-Pi

Reference commit: `e1a586af0ad8956f42ae5b26bba20e48fbf30e00`.

Lodex adapts the Action Fusion file queue and interference checks, and the
ObservationPack archive, projection, excerpt, recall, and ledger logic. Pi tool
registration and TUI APIs are replaced by Lodex's dispatcher, approval engine,
provider adapters, and persistent sessions. Lodex retains its Plan/Build,
filesystem, output, duration, and cancellation policies. ObservationPack is
enabled by Eco mode; Action Fusion is explicitly requested with `thenRun`.

Original files: `src/sol-pi/extensions/action-fusion/{file-queue,then-run}.ts` and
`src/sol-pi/extensions/observation-pack/{index,observation,ledger}.ts`.

Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
