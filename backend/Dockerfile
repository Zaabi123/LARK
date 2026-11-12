FROM python:3.13-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY send.py .
RUN useradd --create-home lark && chown -R lark /app
USER lark
EXPOSE 3007
CMD ["python", "-m", "app.main"]
