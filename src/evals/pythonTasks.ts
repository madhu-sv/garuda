import { lines, PYPROJECT, PYTEST_CHECK } from "./projects.js";
import type { EvalTask } from "./types.js";

/**
 * The Python suite (0.3): five small projects with pytest (src layout). Each tests a different
 * skill: a shared mutable default, a boundary bug, a rename across modules, an implementation
 * from tests, and a sort order. The check reads only pyproject.toml and no conftest.py.
 */

const task = (t: Omit<EvalTask, "check" | "requires">): EvalTask => ({
  ...t,
  files: { "pyproject.toml": PYPROJECT, ...t.files },
  check: PYTEST_CHECK,
  requires: ["pytest"],
});

const cart = (init: string, body: string) =>
  lines(
    "class Cart:",
    '    """A shopping cart. Each cart has its own items."""',
    "",
    `    def __init__(self, items=${init}):`,
    `        ${body}`,
    "",
    "    def add(self, item):",
    "        self.items.append(item)",
    "",
    "    def count(self):",
    "        return len(self.items)",
  );

const chunks = (stop: string) =>
  lines(
    "def chunks(seq, size):",
    '    """Split seq into lists of `size` items. The last list may be shorter."""',
    "    if size < 1:",
    '        raise ValueError("size must be positive")',
    `    return [list(seq[i : i + size]) for i in range(0, ${stop}, size)]`,
  );

const users = (name: string) =>
  lines(
    'NAMES = {1: "ada", 2: "guido"}',
    "",
    "",
    `def ${name}(user_id):`,
    '    return NAMES.get(user_id, "unknown")',
  );
const profile = (name: string) =>
  lines(
    `from app.users import ${name}`,
    "",
    "",
    "def title(user_id):",
    `    return f"Profile of {${name}(user_id)}"`,
  );
const admin = (name: string) =>
  lines(
    "from app import users",
    "",
    "",
    "def is_admin(user_id):",
    `    return users.${name}(user_id) == "ada"`,
  );

const top = (key: string, reverse: string) =>
  lines(
    "def top_players(scores, n):",
    '    """The n best players: highest score first; equal scores in name order."""',
    `    return sorted(scores, key=${key}${reverse})[:n]`,
  );

export const PYTHON_TASKS: readonly EvalTask[] = [
  task({
    id: "py-mutable-default",
    title: "Python: carts share their items",
    prompt:
      "Two Cart objects share the same items, and a test fails. Fix Cart. Do not change the tests.",
    files: {
      "src/shop/__init__.py": "",
      "src/shop/cart.py": cart("[]", "self.items = items"),
      "tests/test_cart.py": lines(
        "from shop.cart import Cart",
        "",
        "",
        "def test_new_carts_are_empty_and_separate():",
        "    first = Cart()",
        '    first.add("tea")',
        "    second = Cart()",
        "    assert second.count() == 0",
        "    assert first.count() == 1",
        "",
        "",
        "def test_a_cart_can_start_with_items():",
        '    items = ["milk"]',
        "    cart = Cart(items)",
        '    cart.add("bread")',
        "    assert cart.count() == 2",
      ),
    },
    solution: {
      "src/shop/cart.py": cart("None", "self.items = [] if items is None else items"),
    },
  }),

  task({
    id: "py-chunks",
    title: "Python: keep the last short chunk",
    prompt:
      "chunks() loses the last items when they do not fill a whole chunk. Fix it without changing the tests.",
    files: {
      "src/listutil/__init__.py": "from listutil.chunks import chunks\n",
      "src/listutil/chunks.py": chunks("len(seq) - size + 1"),
      "tests/test_chunks.py": lines(
        "import pytest",
        "",
        "from listutil import chunks",
        "",
        "",
        "def test_even_split():",
        "    assert chunks([1, 2, 3, 4], 2) == [[1, 2], [3, 4]]",
        "",
        "",
        "def test_last_chunk_may_be_short():",
        "    assert chunks([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]",
        '    assert chunks("abc", 5) == [["a", "b", "c"]]',
        "",
        "",
        "def test_empty_input():",
        "    assert chunks([], 3) == []",
        "",
        "",
        "def test_rejects_a_bad_size():",
        "    with pytest.raises(ValueError):",
        "        chunks([1], 0)",
      ),
    },
    solution: { "src/listutil/chunks.py": chunks("len(seq)") },
  }),

  task({
    id: "py-rename",
    title: "Python: rename a function in every module",
    prompt:
      "Rename the function get_usr to get_user everywhere in src/ (the definition and every use). Then run the tests.",
    files: {
      "src/app/__init__.py": "",
      "src/app/users.py": users("get_usr"),
      "src/app/profile.py": profile("get_usr"),
      "src/app/admin.py": admin("get_usr"),
      "tests/test_app.py": lines(
        "from app.admin import is_admin",
        "from app.profile import title",
        "from app.users import get_user",
        "",
        "",
        "def test_users():",
        '    assert get_user(1) == "ada"',
        '    assert get_user(9) == "unknown"',
        "",
        "",
        "def test_services():",
        '    assert title(2) == "Profile of guido"',
        "    assert is_admin(1)",
      ),
    },
    solution: {
      "src/app/users.py": users("get_user"),
      "src/app/profile.py": profile("get_user"),
      "src/app/admin.py": admin("get_user"),
    },
  }),

  task({
    id: "py-duration",
    title: "Python: implement a duration parser from its tests",
    prompt:
      "Implement parse_duration in src/timeparse/duration.py so that the tests pass. Read the tests first. Do not change the tests.",
    files: {
      "src/timeparse/__init__.py": "",
      "src/timeparse/duration.py": lines(
        "def parse_duration(text):",
        '    """Seconds in a duration such as "1h30m", "45s" or "2h5s"."""',
        '    raise NotImplementedError("parse_duration")',
      ),
      "tests/test_duration.py": lines(
        "import pytest",
        "",
        "from timeparse.duration import parse_duration",
        "",
        "",
        '@pytest.mark.parametrize("text, seconds", [',
        '    ("45s", 45),',
        '    ("2m", 120),',
        '    ("1h30m", 5400),',
        '    ("2h5s", 7205),',
        '    ("1h1m1s", 3661),',
        '    ("0s", 0),',
        "])",
        "def test_valid(text, seconds):",
        "    assert parse_duration(text) == seconds",
        "",
        "",
        '@pytest.mark.parametrize("text", ["", "10", "5x", "1m1h", "1h1h", "h", "1 h", "-1s"])',
        "def test_invalid(text):",
        "    with pytest.raises(ValueError):",
        "        parse_duration(text)",
      ),
    },
    solution: {
      "src/timeparse/duration.py": lines(
        "import re",
        "",
        'PATTERN = re.compile(r"(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?")',
        "",
        "",
        "def parse_duration(text):",
        "    match = PATTERN.fullmatch(text)",
        "    if not text or match is None:",
        '        raise ValueError(f"not a duration: {text!r}")',
        "    hours, minutes, seconds = (int(g) if g else 0 for g in match.groups())",
        "    return hours * 3600 + minutes * 60 + seconds",
      ),
    },
  }),

  task({
    id: "py-top-players",
    title: "Python: fix the order of equal scores",
    prompt:
      "top_players returns players with equal scores in the wrong order, and a test fails. Fix it without changing the tests.",
    files: {
      "src/league/__init__.py": "",
      "src/league/ranking.py": top("scores.get", ", reverse=True"),
      "tests/test_ranking.py": lines(
        "from league.ranking import top_players",
        "",
        'SCORES = {"zed": 5, "amy": 5, "bob": 7, "cat": 1}',
        "",
        "",
        "def test_best_first_and_ties_in_name_order():",
        '    assert top_players(SCORES, 3) == ["bob", "amy", "zed"]',
        "",
        "",
        "def test_n_larger_than_the_list():",
        '    assert top_players(SCORES, 10) == ["bob", "amy", "zed", "cat"]',
        "",
        "",
        "def test_zero():",
        "    assert top_players(SCORES, 0) == []",
      ),
    },
    solution: {
      "src/league/ranking.py": top("lambda name: (-scores[name], name)", ""),
    },
  }),
];
