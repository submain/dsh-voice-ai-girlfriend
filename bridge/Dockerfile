# voice-bridge 镜像
#
# 策略：直接复用本机已构建的 flashhead-service-gpu:latest（FlashHead 完整运行时）。
# 该镜像已内置：gcc/g++/ffmpeg/ffprobe、fastapi/uvicorn/httpx/pydantic、
# numpy/scipy/soundfile/librosa、torch/torchaudio 2.10.0+cu128、transformers、
# huggingface_hub、python-multipart —— 无需 apt、无需换系统源。
# 本镜像只补装缺失的 4 个 Python 包 + docker CLI（管理 DUIX 容器用）。

ARG BASE_IMAGE=flashhead-service-gpu:latest
FROM ${BASE_IMAGE}

# docker CLI（桥接用它管理 DUIX 容器；配合 compose 挂载 /var/run/docker.sock）
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker

# 只装镜像里没有的依赖（pip 走清华镜像）
#   funasr/modelscope —— ASR 本地后端备用（当前默认走远程 sh_asr_service）
#   pilk —— QQ 语音 silk 编码
#   gradio_client —— OmniVoice 回退引擎
ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
RUN pip install --no-cache-dir \
    funasr \
    modelscope \
    pilk==0.2.4 \
    "gradio_client>=0.8,<2" \
    # VAD 插话打断（/api/vad）依赖；--no-deps 保护镜像内 transformers 等版本
    && pip install --no-cache-dir --no-deps speech-to-speech==0.2.10

# 依赖冒烟：关键 import 全通过才算构建成功（funasr 与镜像内 numpy 2.x 的兼容性在此验证）
RUN python -c "import funasr, modelscope, pilk, gradio_client, fastapi, uvicorn, httpx, soundfile, scipy, numpy; import speech_to_speech.VAD.vad_iterator; print('voice-bridge deps ok')"

WORKDIR /app
COPY voice_bridge.py qq_bridge.py /app/

EXPOSE 8765
CMD ["python", "-m", "uvicorn", "voice_bridge:app", "--host", "0.0.0.0", "--port", "8765"]
