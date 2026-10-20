import os
import unittest

class TestTPEFlow(unittest.TestCase):
    def setUp(self):
        os.environ['OMNIPAY_TPE_KEY'] = os.getenv('OMNIPAY_TPE_KEY', 'test_dummy_key_must_be_replaced')

    def test_key_present(self):
        self.assertIn('OMNIPAY_TPE_KEY', os.environ)

if __name__ == '__main__':
    unittest.main()
