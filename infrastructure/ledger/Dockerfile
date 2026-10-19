# Dockerfile for Omnipay ledger service

FROM python:3.11-slim

WORKDIR /app

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends gcc libpq-dev build-essential && rm -rf /var/lib/apt/lists/*

COPY . /app

RUN python -m pip install --upgrade pip
RUN pip install -r infrastructure/ledger/requirements.txt

EXPOSE 8000

ENV PYTHONUNBUFFERED=1

CMD ["uvicorn", "infrastructure.ledger.api:app", "--host", "0.0.0.0", "--port", "8000"]
