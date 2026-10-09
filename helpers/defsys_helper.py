"""defsystem helper: runs the defsys skill's own code and prints one JSON object on stdout.

  python defsys_helper.py inspect     payload on stdin: {"scripts": "<skill scripts dir>", "config": "ds.config.yaml"}
  python defsys_helper.py candidate   payload on stdin: {"scripts": ..., "config": ..., "path": [...], "text": "..."}

inspect runs the skill's generate() in memory and reports the token collections, their modes, every variable with
its value per mode, the contrast failures, and the raw answers.

candidate sets one answer in a copy of the config, checks the copy with the same code in a temporary folder, and
reports the new YAML, a diff against the current file, and the contrast failures.

Neither action writes into the project folder. The panel writes the YAML itself, after the person presses Apply.
"""
import difflib
import json
import sys
import tempfile
from pathlib import Path


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True, default=str))
    sys.stdout.flush()


def load_skill(scripts):
    sys.path.insert(0, scripts)
    import config  # noqa: F401  (importing it also puts the vendored PyYAML on the path)
    import yaml
    import build
    return yaml, build


def variable_json(variable):
    values = {}
    for mode, value in variable.values.items():
        if hasattr(value, 'target'):
            values[mode] = {'alias': value.target}
        elif value is None or isinstance(value, (str, int, float, bool)):
            values[mode] = value
        else:
            values[mode] = str(value)
    return {'path': variable.path, 'type': variable.type, 'values': values}


def collection_json(collection):
    return {
        'name': collection.name,
        'modes': list(collection.modes),
        'variables': [variable_json(v) for v in collection.variables],
    }


def failing_pairs(results):
    return [f'{r.id} ({r.mode}): {r.ratio:.2f}:1 < {r.required:g}:1' for r in results if not r.passed]


def inspect(payload, yaml, build):
    path = payload.get('config', 'ds.config.yaml')
    raw = yaml.safe_load(Path(path).read_text(encoding='utf-8')) or {}
    try:
        _cfg, _prims, collections, results, _notes = build.generate(path)
    except ValueError as e:
        return {'ok': False, 'error': str(e), 'config': raw, 'collections': [], 'failing': []}
    except Exception as e:  # report it to the panel, never crash it
        return {'ok': False, 'error': f'{type(e).__name__}: {e}', 'config': raw, 'collections': [], 'failing': []}
    return {
        'ok': True,
        'error': '',
        'config': raw,
        'collections': [collection_json(c) for c in collections],
        'failing': failing_pairs(results),
    }


def parent_of(root, path):
    """Walk to the container of path[-1], creating missing map levels so a new answer can be added."""
    node = root
    for key in path[:-1]:
        if isinstance(node, list):
            node = node[int(key)]
        else:
            if node.get(key) is None:
                node[key] = {}
            node = node[key]
    return node


def coerce(original, text, kind=None):
    """Turn the typed text into the type the answer already has, or the kind given for a new answer."""
    text = text.strip()
    if original is None and kind:
        if kind == 'number':
            return float(text) if '.' in text else int(text)
        if kind == 'list':
            return [item.strip() for item in text.split(',') if item.strip()]
        if kind == 'bool':
            return coerce(True, text)
        return text
    if isinstance(original, bool):
        if text.lower() in ('true', 'yes', 'on'):
            return True
        if text.lower() in ('false', 'no', 'off'):
            return False
        raise ValueError('type true or false')
    if isinstance(original, int):
        return int(text)
    if isinstance(original, float):
        return float(text)
    if isinstance(original, list):
        items = [item.strip() for item in text.split(',') if item.strip()]
        if original and all(isinstance(item, int) and not isinstance(item, bool) for item in original):
            return [int(item) for item in items]
        return items
    return text


def candidate(payload, yaml, build):
    path = [str(key) for key in payload.get('path', [])]
    text = payload.get('text', '')
    kind = payload.get('kind')
    config_path = payload.get('config', 'ds.config.yaml')
    source = Path(config_path).read_text(encoding='utf-8')
    before = yaml.safe_load(source) or {}
    after = yaml.safe_load(source) or {}
    try:
        container = parent_of(after, path)
        last = path[-1]
        if isinstance(container, list):
            container[int(last)] = coerce(container[int(last)], text, kind)
        else:
            container[last] = coerce(container.get(last), text, kind)
    except (KeyError, IndexError, TypeError, ValueError) as e:
        return {'ok': False, 'error': f'Cannot set {" / ".join(path)}: {e}', 'yaml': '', 'diff': '', 'failing': []}

    dump = dict(sort_keys=False, allow_unicode=True, default_flow_style=False, width=1000)
    old_text = yaml.safe_dump(before, **dump)
    new_text = yaml.safe_dump(after, **dump)
    diff = ''.join(difflib.unified_diff(
        old_text.splitlines(True),
        new_text.splitlines(True),
        'ds.config.yaml (now)',
        'ds.config.yaml (after)',
        n=2,
    ))

    # Check the copy with the skill's own code, in a temporary folder outside the project.
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / 'ds.config.yaml'
        copy.write_text(new_text, encoding='utf-8')
        try:
            _cfg, _prims, _collections, results, _notes = build.generate(str(copy))
        except ValueError as e:
            return {'ok': False, 'error': str(e), 'yaml': new_text, 'diff': diff, 'failing': []}
        except Exception as e:
            return {'ok': False, 'error': f'{type(e).__name__}: {e}', 'yaml': new_text, 'diff': diff, 'failing': []}
    return {'ok': True, 'error': '', 'yaml': new_text, 'diff': diff, 'failing': failing_pairs(results)}


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else ''
    try:
        # utf-8-sig drops a byte-order mark if the caller wrote one; plain utf-8 keeps it and json.loads then fails.
        payload = json.loads(sys.stdin.buffer.read().decode('utf-8-sig') or '{}')
        yaml, build = load_skill(payload['scripts'])
    except Exception as e:
        emit({'ok': False, 'error': f'helper could not start: {type(e).__name__}: {e}'})
        return
    if action == 'inspect':
        emit(inspect(payload, yaml, build))
    elif action == 'candidate':
        emit(candidate(payload, yaml, build))
    else:
        emit({'ok': False, 'error': f'unknown action: {action!r}'})


if __name__ == '__main__':
    main()
