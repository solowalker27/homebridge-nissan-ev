"""Dependency probe that runs with the system Python; no Nissan credentials or network."""
import importlib.metadata
import json
import sys


def check():
    result = {'pythonVersion': '.'.join(str(n) for n in sys.version_info[:3]),
              'pythonSupported': sys.version_info >= (3, 12), 'ready': False}
    if not result['pythonSupported']:
        result['reason'] = 'python-version'
        return result
    try:
        result['pynissanVersion'] = importlib.metadata.version('pynissan')
        result['aiohttpVersion'] = importlib.metadata.version('aiohttp')
        import pynissan
        import aiohttp
        import fcntl
        aio_version = tuple(int(n) for n in aiohttp.__version__.split('.')[:2])
        result['ready'] = result['pynissanVersion'] == '0.2.1' and (3, 12) <= aio_version < (4, 0)
        if not result['ready']:
            result['reason'] = 'dependency-version'
    except Exception:
        result['reason'] = 'dependencies'
    return result


if __name__ == '__main__':
    print(json.dumps(check()))
