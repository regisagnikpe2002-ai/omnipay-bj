"""
Prototype de scoring basique pour Omnipay-bj.

- Récupère les transactions récentes depuis Postgres
- Calcule quelques features simples
- Scoring avec IsolationForest
- Met à jour la colonne detected_anomaly et anomaly_score
- Envoie une alerte Slack (webhook placeholder) si anomalie détectée

Notes :
- Configure la variable d'environnement DATABASE_URL et SLACK_WEBHOOK_URL avant usage.
- Ne pas exécuter avec des secrets en clair dans le code.
"""

import os
import json
import time
import logging
from datetime import datetime, timedelta

import psycopg2
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
import requests

logging.basicConfig(level=logging.INFO)

DATABASE_URL = os.getenv('DATABASE_URL')  # ex: postgres://user:pass@host:5432/db
SLACK_WEBHOOK_URL = os.getenv('SLACK_WEBHOOK_URL')  # placeholder

# Paramètres
LOOKBACK_HOURS = int(os.getenv('LOOKBACK_HOURS', '24'))
SAMPLE_SIZE = int(os.getenv('SAMPLE_SIZE', '10000'))


def fetch_transactions(conn, lookback_hours=24, limit=10000):
    query = '''
    SELECT id, gross_amount::float AS gross_amount, provider_fees::float AS fees, currency, created_at,
           (extract(epoch from now()) - extract(epoch from created_at)) AS age_seconds
    FROM transactions
    WHERE created_at > now() - interval '%s hours'
    ORDER BY created_at DESC
    LIMIT %s
    ''' % (lookback_hours, limit)

    df = pd.read_sql_query(query, conn)
    return df


def build_features(df):
    # features: gross_amount, fees_ratio, age_seconds
    df = df.copy()
    df['fees_ratio'] = np.where(df['gross_amount'] > 0, df['fees'] / df['gross_amount'], 0)
    df['log_amount'] = np.log1p(df['gross_amount'].clip(lower=0))
    df['age_hours'] = df['age_seconds'] / 3600.0
    features = df[['log_amount', 'fees_ratio', 'age_hours']].fillna(0)
    return df, features


def score_and_update(conn, df, features):
    if len(df) == 0:
        logging.info('No transactions to score')
        return

    model = IsolationForest(n_estimators=100, contamination=0.01, random_state=42)
    model.fit(features)
    scores = -model.decision_function(features)  # higher == more anomalous

    df['anomaly_score'] = scores
    df['is_anomaly'] = df['anomaly_score'] > np.percentile(scores, 99)  # top 1%

    cur = conn.cursor()
    for _, row in df.iterrows():
        cur.execute(
            "UPDATE transactions SET detected_anomaly = %s, anomaly_score = %s, updated_at = now() WHERE id = %s",
            (bool(row['is_anomaly']), float(row['anomaly_score']), row['id'])
        )
        if row['is_anomaly']:
            # send alert
            payload = {
                'text': f"[Omnipay] Anomalie détectée transaction {row['id']} score={row['anomaly_score']:.4f}"
            }
            if SLACK_WEBHOOK_URL:
                try:
                    requests.post(SLACK_WEBHOOK_URL, json=payload, timeout=5)
                except Exception as e:
                    logging.warning('Failed to send slack alert: %s', e)

    conn.commit()
    cur.close()


def main():
    if DATABASE_URL is None:
        logging.error('DATABASE_URL not set')
        return

    conn = psycopg2.connect(DATABASE_URL)
    try:
        df = fetch_transactions(conn, LOOKBACK_HOURS, SAMPLE_SIZE)
        df, features = build_features(df)
        score_and_update(conn, df, features)
    finally:
        conn.close()


if __name__ == '__main__':
    main()
