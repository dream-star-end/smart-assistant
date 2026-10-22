"""Offline, per-call worker; stdin pixels and one bounded JSON answer are private."""
import os
import sys

protocol = os.dup(1)
os.dup2(2, 1)  # SDK/native output goes to the parent's ignored stderr.

try:
    import hashlib
    import importlib.util
    import io
    import json
    from pathlib import Path
    import re
    import resource

    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    allowed = os.sched_getaffinity(0)
    os.sched_setaffinity(0, {min(allowed)})
    data = sys.stdin.buffer.read(256 * 1024 + 1)
    if not data.startswith(b'\x89PNG\r\n\x1a\n') or len(data) > 256 * 1024:
        raise ValueError()

    spec = importlib.util.find_spec('ddddocr')
    if spec is None or spec.origin is None:
        raise ValueError()
    package = Path(spec.origin).parent
    pins = {
        'common_old.onnx': 'b8f2ad9cbc1f2e3922a6cb9459e30824e7e2467f3fb4fd61420640e34ea0bf68',
        'models/charset_manager.py': 'bee4347baa20cda88fe8510032a2438648cad2c10f8f0eec26fb59fa2b129d9c',
        'compat/v1.py': 'e3cbf1b783ee68d3e8750c1f916672ad9b76b982a0ff0611e9c52ae11347e2cf',
        'models/model_loader.py': '950d9c5977d42816a2315299f67b0d402074aeacdd9295bbfa5ea53428e21faf',
    }
    for name, expected in pins.items():
        digest = hashlib.sha256()
        with (package / name).open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError()

    from PIL import Image
    Image.MAX_IMAGE_PIXELS = 1024 * 256
    with Image.open(io.BytesIO(data)) as image:
        if (image.format != 'PNG' or image.width > 1024 or image.height > 256
                or getattr(image, 'n_frames', 1) != 1):
            raise ValueError()
        image.load()

    import cv2
    cv2.setNumThreads(1)
    import onnxruntime
    session_options = onnxruntime.SessionOptions()
    session_options.intra_op_num_threads = 1
    session_options.inter_op_num_threads = 1
    session_options.execution_mode = onnxruntime.ExecutionMode.ORT_SEQUENTIAL
    original_session = onnxruntime.InferenceSession

    def single_thread_session(*args, **kwargs):
        if len(args) < 2 and 'sess_options' not in kwargs:
            kwargs['sess_options'] = session_options
        return original_session(*args, **kwargs)

    # The pinned SDK lacks a SessionOptions hook. This process owns this symbol.
    onnxruntime.InferenceSession = single_thread_session
    try:
        import ddddocr
        engine = ddddocr.DdddOcr(ocr=True, det=False, old=False, beta=False,
                                use_gpu=False, show_ad=False)
    finally:
        onnxruntime.InferenceSession = original_session
    answer = engine.classification(data, png_fix=False, probability=False)
    if not isinstance(answer, str) or re.fullmatch(r'[A-Za-z0-9]{1,8}', answer) is None:
        raise ValueError()
    output = json.dumps({'v': 1, 'answer': answer}, separators=(',', ':')).encode('utf-8')
    if len(output) > 256:
        raise ValueError()
    os.write(protocol, output)
    os.close(protocol)
except BaseException:
    # No traceback, input, answer or dependency exception crosses this boundary.
    os._exit(2)
