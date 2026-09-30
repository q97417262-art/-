"""
Помощник автовыдачи Adopt Me: смотрит на экран и кликает как человек.
Никаких эксплойтов и инъекций в Roblox: только скриншоты, поиск картинок
и клики мышью.

Общение с приложением: команды приходят JSON-строками в stdin, события
уходят JSON-строками в stdout.
  → {"cmd":"deliver","id":"...","buyer":"nick","pets":[{"name","search","image","count"}],"opts":{...}}
  → {"cmd":"check"}          проверить зависимости и распознавание текста
  → {"cmd":"stop"}           остановить текущую выдачу
  ← {"type":"log"|"step"|"done"|"error"|"ready"|"check", ...}

АВАРИЙНАЯ ОСТАНОВКА: резко уведи мышь в левый верхний угол экрана.
"""
import json
import os
import re
import sys
import threading
import time
from difflib import SequenceMatcher

HERE = os.path.dirname(os.path.abspath(__file__))
TPL_DIR = os.path.join(HERE, 'templates')

sys.stdout.reconfigure(encoding='utf-8')
sys.stdin.reconfigure(encoding='utf-8')


def emit(type_, **kw):
    kw['type'] = type_
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def log(msg):
    emit('log', msg=msg)


# Координаты скриншота и мыши должны совпадать при масштабе Windows 125/150%.
try:
    import ctypes
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass

MISSING = []
try:
    import numpy as np
    import cv2
except Exception:
    MISSING.append('opencv-python numpy')
try:
    import mss
except Exception:
    MISSING.append('mss')
try:
    import pyautogui
    pyautogui.FAILSAFE = True   # мышь в левый верхний угол = аварийная остановка
    pyautogui.PAUSE = 0.02
except Exception:
    MISSING.append('pyautogui')
try:
    from PIL import Image
except Exception:
    MISSING.append('pillow')

# ── Распознавание текста (ник): встроенное в Windows, запасной вариант Tesseract
OCR_ENGINE = None
try:
    import winocr  # pip install winocr
    OCR_ENGINE = 'windows'
except Exception:
    try:
        import pytesseract
        pytesseract.get_tesseract_version()
        OCR_ENGINE = 'tesseract'
    except Exception:
        OCR_ENGINE = None


def ocr(bgr, zoom=2):
    if OCR_ENGINE is None:
        return ''
    img = cv2.resize(bgr, None, fx=zoom, fy=zoom, interpolation=cv2.INTER_CUBIC)
    pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    try:
        if OCR_ENGINE == 'windows':
            r = winocr.recognize_pil_sync(pil, 'en')
            return (r.get('text') if isinstance(r, dict) else getattr(r, 'text', '')) or ''
        return pytesseract.image_to_string(pil)
    except Exception as e:
        log(f'OCR ошибка: {e}')
        return ''


def norm_nick(s):
    s = s.lower()
    s = s.translate(str.maketrans({'0': 'o', '1': 'l', 'i': 'l', '|': 'l', '5': 's', '8': 'b'}))
    return re.sub(r'[^a-z0-9_]', '', s)


def nick_exact(text, buyer):
    b = norm_nick(buyer)
    return bool(b) and any(norm_nick(t) == b for t in re.split(r'\s+', text))


def nick_matches(text, buyer, need=0.86):
    """Есть ли в распознанном тексте ник покупателя (с поправкой на ошибки OCR)."""
    b = norm_nick(buyer)
    if not b:
        return False, 0.0
    if nick_exact(text, buyer):
        return True, 1.0
    best = 0.0
    for token in re.split(r'\s+', text):
        t = norm_nick(token)
        if not t:
            continue
        best = max(best, SequenceMatcher(None, t, b).ratio())
        if b in t and len(t) - len(b) <= 2:
            best = max(best, 0.97)
    return best >= need, round(best, 2)


def imread(p):
    # cv2.imread не открывает пути с русскими буквами на Windows
    try:
        return cv2.imdecode(np.fromfile(p, dtype=np.uint8), cv2.IMREAD_COLOR)
    except Exception:
        return None


class Stopped(Exception):
    pass


class Fail(Exception):
    pass


class Trader:
    def __init__(self):
        self.stop_flag = threading.Event()
        self.scale = None          # масштаб интерфейса игры относительно шаблонов
        self.tpl = {}
        self.sct = None
        if not MISSING:
            for f in os.listdir(TPL_DIR):
                if f.endswith('.png'):
                    self.tpl[f[:-4]] = imread(os.path.join(TPL_DIR, f))

    # ── экран ──────────────────────────────────────────────
    def grab(self):
        if self.sct is None:
            self.sct = mss.mss()
        mon = self.sct.monitors[0]  # все мониторы сразу
        img = np.array(self.sct.grab(mon))[:, :, :3]
        return np.ascontiguousarray(img), (mon['left'], mon['top'])

    def check_stop(self):
        if self.stop_flag.is_set():
            raise Stopped()

    def sleep(self, sec):
        end = time.time() + sec
        while time.time() < end:
            self.check_stop()
            time.sleep(0.05)

    def scales(self):
        if self.scale:
            s = self.scale
            return [s, s * 0.97, s * 1.03, s * 0.94, s * 1.06]
        return [x / 100 for x in range(50, 201, 5)]

    def match(self, screen, tpl, region=None, scales=None, gray=True):
        """Лучшее совпадение шаблона → (score, x, y, w, h, scale) в координатах screen."""
        ox = oy = 0
        if region:
            x0, y0, x1, y1 = [int(v) for v in region]
            H, W = screen.shape[:2]
            x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
            if x1 - x0 < 8 or y1 - y0 < 8:
                return (0, 0, 0, 0, 0, 1)
            screen = screen[y0:y1, x0:x1]
            ox, oy = x0, y0
        src = cv2.cvtColor(screen, cv2.COLOR_BGR2GRAY) if gray else screen
        best = (0, 0, 0, 0, 0, 1)
        for s in (scales or self.scales()):
            t = cv2.resize(tpl, None, fx=s, fy=s, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
            if gray:
                t = cv2.cvtColor(t, cv2.COLOR_BGR2GRAY)
            th, tw = t.shape[:2]
            if th > src.shape[0] or tw > src.shape[1] or th < 6 or tw < 6:
                continue
            r = cv2.matchTemplate(src, t, cv2.TM_CCOEFF_NORMED)
            _, mx, _, loc = cv2.minMaxLoc(r)
            if mx > best[0]:
                best = (mx, loc[0] + ox, loc[1] + oy, tw, th, s)
        return best

    def find(self, name, screen, thr=0.78, region=None):
        m = self.match(screen, self.tpl[name], region)
        if m[0] >= thr:
            if self.scale is None:
                self.scale = m[5]
                log(f'масштаб интерфейса игры: {m[5]:.2f}')
            return m
        return None

    def wait_for(self, names, timeout, thr=0.78, every=0.35):
        """Ждёт, пока на экране появится одна из картинок. → (name, match, screen, offset)"""
        end = time.time() + timeout
        while time.time() < end:
            self.check_stop()
            screen, off = self.grab()
            for n in names:
                m = self.find(n, screen, thr)
                if m:
                    return n, m, screen, off
            time.sleep(every)
        return None, None, None, None

    # ── мышь ───────────────────────────────────────────────
    def click(self, off, m, dx=0.5, dy=0.5):
        self.check_stop()
        x = off[0] + m[1] + m[3] * dx
        y = off[1] + m[2] + m[4] * dy
        pyautogui.moveTo(x - 6, y - 4, duration=0.12)
        pyautogui.moveTo(x, y, duration=0.08)   # Roblox реагирует на наведение
        time.sleep(0.06)
        pyautogui.mouseDown()
        time.sleep(0.06)
        pyautogui.mouseUp()
        time.sleep(0.15)

    def click_at(self, off, x, y):
        self.click(off, (1, x, y, 0, 0, 1))

    # ── вспомогательное ───────────────────────────────────
    @staticmethod
    def is_green(screen, m):
        _, x, y, w, h, _ = m
        p = screen[y + h // 4: y + h * 3 // 4, x + w // 8: x + w * 7 // 8].reshape(-1, 3).astype(float)
        b, g, r = p.mean(0)
        return g - r > 45 and g - b > 45

    def rel(self, m, box):
        """Прямоугольник относительно найденного якоря (в пикселях шаблона)."""
        s = m[5]
        return (m[1] + box[0] * s, m[2] + box[1] * s, m[1] + box[2] * s, m[2] + box[3] * s)

    @staticmethod
    def filled_slots(screen, box):
        """Сколько из 9 ячеек сетки заняты (пустая — ровная серая, «+» — зелёная)."""
        x0, y0, x1, y1 = [int(v) for v in box]
        a = screen[max(0, y0):y1, max(0, x0):x1].astype(float)
        h, w = a.shape[:2]
        if h < 30 or w < 30:
            return -1
        n = 0
        for r in range(3):
            for c in range(3):
                p = a[int(h * (r + .25) / 3):int(h * (r + .75) / 3), int(w * (c + .25) / 3):int(w * (c + .75) / 3)].reshape(-1, 3)
                b, g, rr = p.mean(0)
                std = p.std(0).mean()
                empty = std < 8 and abs(rr - 148) < 22 and abs(g - 153) < 22 and abs(b - 147) < 22
                plus = g - rr > 50 and g - b > 50
                if not empty and not plus:
                    n += 1
        return n

    def load_pet(self, pet):
        img = imread(pet['image'])
        if img is None:
            raise Fail(f'не открывается картинка питомца «{pet["name"]}»')
        h, w = img.shape[:2]
        # центр иконки: без фона ячейки, рамки и значков по углам
        return img[int(h * .14):int(h * .86), int(w * .14):int(w * .86)]

    def ocr_box(self, screen, box):
        x0, y0, x1, y1 = [max(0, int(v)) for v in box]
        return ocr(screen[y0:y1, x0:x1]).strip()

    # ── выдача ─────────────────────────────────────────────
    def deliver(self, job):
        buyer = job['buyer']
        pets = job['pets']
        o = job.get('opts', {})
        need_total = sum(int(p.get('count', 1)) for p in pets)
        check_nick = o.get('checkNick', True)
        if check_nick and OCR_ENGINE is None:
            raise Fail('нет распознавания текста — проверить ник нельзя. Поставь winocr (pip install winocr)')
        if need_total > 9:
            raise Fail('в один трейд помещается максимум 9 предметов')

        focus_roblox()

        # 1. Запрос на трейд от покупателя
        emit('step', step='request', msg=f'жду запрос на трейд от {buyer}')
        end = time.time() + o.get('requestTimeout', 600)
        while True:
            left = end - time.time()
            if left <= 0:
                raise Fail(f'{buyer} так и не отправил трейд')
            n, m, screen, off = self.wait_for(['req_title'], left, thr=0.72)
            if not m:
                continue
            text = self.ocr_box(screen, self.rel(m, (-40, -125, 370, -60)))
            ok, score = nick_matches(text, buyer) if check_nick else (True, 1)
            dec = self.find('req_decline', screen, 0.7, self.rel(m, (-80, 20, 420, 140)))
            acc = self.find('req_accept', screen, 0.7, self.rel(m, (-80, 20, 420, 140)))
            if ok and acc:
                req_exact = score == 1.0
                log(f'запрос от «{text}» — это покупатель (совпадение {score})')
                self.click(off, acc)
                break
            log(f'чужой запрос «{text}» (совпадение {score}) — отклоняю')
            if dec:
                self.click(off, dec)
            self.sleep(1.5)

        # 2. Окно трейда
        emit('step', step='trade', msg='открываю трейд')
        n, center, screen, off = self.wait_for(['trade_center'], 15, thr=0.7)
        if not center:
            raise Fail('окно трейда не открылось')
        if check_nick:
            # Похожие ники (artem121356 vs artemm121356) — любимый трюк скамеров,
            # поэтому хотя бы одно прочтение ника должно совпасть ТОЧНО.
            box = self.rel(center, (150, -95, 360, -50))
            x0, y0, x1, y1 = [max(0, int(v)) for v in box]
            reads = [ocr(screen[y0:y1, x0:x1], z) for z in (2, 3)]
            exact = req_exact or any(nick_exact(r, buyer) for r in reads)
            fuzzy = any(nick_matches(r, buyer)[0] for r in reads)
            if not (exact and fuzzy):
                self.decline(screen, off)
                raise Fail(f'ник в трейде не совпал точно с {buyer} (прочитал: {" / ".join(r.strip() for r in reads)}) — трейд отклонён')

        # 3. Кладём питомцев
        for pet in pets:
            icon = self.load_pet(pet)
            for i in range(int(pet.get('count', 1))):
                emit('step', step='add', msg=f'кладу {pet["name"]} ({i + 1}/{pet.get("count", 1)})')
                self.add_pet(pet, icon)

        # закрыть рюкзак, если остался открытым
        screen, off = self.grab()
        close = self.find('bp_close', screen, 0.75)
        if close and self.find('bp_title', screen, 0.72):
            self.click(off, close)
            self.sleep(0.6)

        # 4. Проверка и Accept (кнопка активна после таймера, до ~15 сек)
        self.accept_and_confirm(need_total, o)
        emit('done', id=job.get('id'), msg=f'выдано: {buyer}')

    def add_pet(self, pet, icon):
        screen, off = self.grab()
        if not self.find('bp_title', screen, 0.72):
            center = self.find('trade_center', screen, 0.7)
            if not center:
                raise Fail('трейд закрылся (покупатель отменил?)')
            grid = self.rel(center, (-270, -65, -5, 197))
            plus = self.find('trade_plus', screen, 0.72, grid)
            if not plus:
                raise Fail('не нашёл кнопку «+» в трейде')
            self.click(off, plus)
            n, m, screen, off = self.wait_for(['bp_title'], 6, thr=0.72)
            if not m:
                raise Fail('рюкзак не открылся')
            self.sleep(0.4)
            screen, off = self.grab()

        title = self.find('bp_title', screen, 0.72)
        search = self.find('bp_search', screen, 0.7)
        if search and pet.get('search'):
            self.click(off, search)
            pyautogui.hotkey('ctrl', 'a')
            pyautogui.press('backspace')
            pyautogui.write(pet['search'], interval=0.04)
            self.sleep(1.0)
            screen, off = self.grab()

        # сетка рюкзака: правее и ниже заголовка BACKPACK
        s = title[5]
        region = (title[1] + 90 * s, title[2] + 30 * s, title[1] + 470 * s, title[2] + 330 * s)
        m = self.match(screen, icon, region, gray=False, scales=[s * k for k in (0.9, 0.95, 1, 1.05, 1.1)])
        thr = self.opts_thr
        if m[0] < thr:
            raise Fail(f'не нашёл «{pet["name"]}» в рюкзаке (похожесть {m[0]:.2f}, нужно {thr}). Кончился или картинка не та?')
        log(f'нашёл {pet["name"]} (похожесть {m[0]:.2f})')
        self.click(off, m)
        self.sleep(0.8)

    def decline(self, screen, off):
        d = self.find('trade_decline', screen, 0.7)
        if d:
            self.click(off, d)

    def accept_and_confirm(self, need_total, o):
        end = time.time() + o.get('confirmTimeout', 180)
        confirmed = False
        shown_conf = False
        while time.time() < end:
            self.check_stop()
            screen, off = self.grab()

            conf = self.find('conf_title', screen, 0.72)
            if conf:
                if not shown_conf:
                    shown_conf = True
                    emit('step', step='confirm', msg='экран «Is this trade fair?», жду Confirm')
                got = self.filled_slots(screen, self.rel(conf, (-4, 71, 207, 282)))
                if got != need_total:
                    self.decline(screen, off)
                    raise Fail(f'на экране подтверждения {got} предм. вместо {need_total} — трейд отклонён')
                btn_area = self.rel(conf, (80, 270, 470, 350))
                btn = self.find('conf_confirm', screen, 0.7, btn_area) or self.find('conf_confirm_wait', screen, 0.7, btn_area)
                if btn and self.is_green(screen, btn):
                    self.click(off, btn)
                    confirmed = True
                    self.sleep(1.5)
                time.sleep(0.4)
                continue

            center = self.find('trade_center', screen, 0.7)
            if center:
                got = self.filled_slots(screen, self.rel(center, (-265, -60, -12, 192)))
                if got != need_total:
                    self.decline(screen, off)
                    raise Fail(f'в трейде {got} предм. вместо {need_total} — трейд отклонён, проверь вручную')
                acc = self.find('trade_accept', screen, 0.68, self.rel(center, (-150, 190, 250, 270)))
                shown_conf = False
                if acc and self.is_green(screen, acc):
                    emit('step', step='accept', msg='жму Accept')
                    self.click(off, acc)
                    self.sleep(1.0)
                time.sleep(0.4)
                continue

            # ни трейда, ни подтверждения на экране
            if confirmed:
                return
            raise Fail('трейд закрылся до подтверждения (покупатель отменил?)')
        raise Fail('покупатель слишком долго не подтверждает трейд')


def focus_roblox():
    """Вывести окно Roblox на передний план (Windows)."""
    try:
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        found = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def cb(hwnd, _):
            n = user32.GetWindowTextLengthW(hwnd)
            if n and user32.IsWindowVisible(hwnd):
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                if buf.value.strip() == 'Roblox':
                    found.append(hwnd)
            return True
        user32.EnumWindows(cb, 0)
        if not found:
            raise Fail('окно Roblox не найдено — зайди в Adopt Me')
        h = found[0]
        user32.ShowWindow(h, 9)                 # SW_RESTORE
        user32.keybd_event(0x12, 0, 0, 0)       # Alt: иначе Windows не отдаст фокус
        user32.SetForegroundWindow(h)
        user32.keybd_event(0x12, 0, 2, 0)
        time.sleep(0.4)
    except Fail:
        raise
    except Exception as e:
        log(f'не смог активировать окно Roblox: {e}')


def main():
    if MISSING:
        emit('error', fatal=True, msg='не хватает библиотек Python: pip install ' + ' '.join(MISSING))
    t = Trader()
    jobs = []
    lock = threading.Condition()

    def reader():
        for line in sys.stdin:
            try:
                cmd = json.loads(line)
            except Exception:
                continue
            if cmd.get('cmd') == 'stop':
                t.stop_flag.set()
            else:
                with lock:
                    jobs.append(cmd)
                    lock.notify()
        t.stop_flag.set()
        with lock:
            jobs.append({'cmd': 'exit'})
            lock.notify()

    threading.Thread(target=reader, daemon=True).start()
    emit('ready', ocr=OCR_ENGINE, missing=MISSING)
    while True:
        with lock:
            while not jobs:
                lock.wait()
            job = jobs.pop(0)
        c = job.get('cmd')
        if c == 'exit':
            break
        if c == 'check':
            emit('check', ocr=OCR_ENGINE, missing=MISSING, templates=len(t.tpl))
            continue
        if c != 'deliver' or MISSING:
            continue
        t.stop_flag.clear()
        t.opts_thr = float(job.get('opts', {}).get('petThreshold', 0.8))
        try:
            t.deliver(job)
        except Stopped:
            emit('error', id=job.get('id'), msg='выдача остановлена')
        except Fail as e:
            emit('error', id=job.get('id'), msg=str(e))
        except pyautogui.FailSafeException:
            emit('error', id=job.get('id'), msg='аварийная остановка (мышь в углу экрана)')
        except Exception as e:
            emit('error', id=job.get('id'), msg=f'неожиданная ошибка: {e!r}')


if __name__ == '__main__':
    main()
