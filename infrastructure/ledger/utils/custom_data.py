from collections import OrderedDict
import json

# Ordre strict demandé (ne modifie pas l'ordre)
CUSTOM_KEYS = [
    ("activity_type", "activity_type"),
    ("user_name", "user_name"),
    ("user_number", "user_number"),
    ("user_email", "user_email"),
    ("user_country_code", "user_country_code"),
    ("user_account_id", "user_account_id"),
    ("id_transfer_1", "id_transfer_1"),
    ("id_transfer_2", "id_transfer_2"),
    ("account_id", "account_id"),
    ("beneficiary_name", "beneficiary_name"),
    ("beneficiary_card", "beneficiary_card"),
    ("operator_country", "operator_country"),
    ("operator_name", "operator_name"),
    ("user_ip_adress", "user_ip_adress"),
    ("user_mac_adress", "user_mac_adress"),
    ("user_payment_url", "user_payment_url"),
    ("user_agent", "user_agent"),
]


def build_custom_data(payload: dict) -> (str, str):
    """
    Build ordered custom data in two formats:
      - kv_string: '"k1":"v1","k2":"v2"' (order preserved)
      - json_str: JSON string representation

    Rules:
    - Keep the keys in the exact order defined in CUSTOM_KEYS
    - If a value is missing, include the key with an empty value
    - Sanitize double quotes/newlines from string values
    """
    od = OrderedDict()
    for key, _ in CUSTOM_KEYS:
        value = payload.get(key, "")
        if isinstance(value, str):
            safe = value.replace('"', "'").replace("\n", " ").strip()
        elif value is None:
            safe = ""
        else:
            safe = str(value)
        od[key] = safe

    kv_pairs = [f'"{k}":"{v}"' for k, v in od.items()]
    kv_string = ",".join(kv_pairs)
    json_str = json.dumps(od, ensure_ascii=False)
    return kv_string, json_str


def parse_kv_custom_data(kv_string: str) -> dict:
    """
    Parse the kv_string back into a dict.
    This parser is conservative and assumes values don't contain the sequence '","'.
    If the provider can send JSON, prefer parsing JSON.
    """
    result = {}
    if not kv_string:
        return result
    # Split by ',' between pairs but keep quoted values safe by a simple approach
    parts = []
    current = ''
    in_quotes = False
    i = 0
    while i < len(kv_string):
        ch = kv_string[i]
        current += ch
        if ch == '"':
            # toggle in_quotes unless it's an escaped quote (we replaced double-quotes)
            in_quotes = not in_quotes
        elif ch == ',' and not in_quotes:
            parts.append(current[:-1])
            current = ''
        i += 1
    if current:
        parts.append(current)

    for p in parts:
        p = p.strip()
        if p.startswith('"') and p.endswith('"'):
            p = p[1:-1]
        # split on '":"' first occurrence
        if '\":\"' in p:
            k, v = p.split('\":\"', 1)
        elif '\":' in p:
            k, v = p.split('\":', 1)
        else:
            # fallback split on first ':'
            if ':' in p:
                k, v = p.split(':', 1)
            else:
                continue
        # strip surrounding quotes if present
        k = k.strip().strip('"')
        v = v.strip().strip('"')
        result[k] = v
    return result
