import os
from decimal import Decimal
from infrastructure.ledger.business.splits import quantize_amount


def test_commission_calculation():
    gross = Decimal('1000')
    fixed = Decimal('50')
    pct = Decimal('0.02')
    commission = fixed + gross * pct
    commission = quantize_amount(commission)
    net = quantize_amount(gross - commission)
    assert commission == Decimal('70.00')
    assert net == Decimal('930.00')


if __name__ == '__main__':
    test_commission_calculation()
    print('tests passed')
