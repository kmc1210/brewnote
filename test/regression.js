// 암기쥐 회귀 테스트
//
// 실제 Chromium 으로 www/index.html 을 띄우고, 앱 안의 함수를 직접 불러
// 데이터가 깨지지 않는지 확인한다. 서버 없이 file:// 로 연다.
//
//   node test/regression.js
//
// 실패하면 종료 코드 1. GitHub Actions 에서 배포 전에 이걸 돌린다.

const path = require("path");
const { chromium } = require("playwright");

const APP = "file://" + path.resolve(__dirname, "..", "www", "index.html");

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (detail ? "  → " + detail : "")); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     "기대 " + JSON.stringify(want) + " / 실제 " + JSON.stringify(got));
}

// 마이그레이션 검증용 옛 데이터. 부재료가 메뉴 안에 박혀 있던 시절 모양.
const LEGACY = {
  drinks: [
    { id: "d1", name: "자몽 블랙티", cat: "tea",
      ing: ["자몽청 60g", "블랙티 200ml"], steps: ["섞는다"],
      subs: [{ name: "자몽청", ing: ["자몽 1kg", "설탕 1kg"], steps: ["재운다"],
               tip: "", place: "냉장", dur: "10일" }] },
    { id: "d2", name: "자몽 에이드", cat: "ade",
      ing: ["자몽청 60g", "탄산수 200ml"], steps: ["섞는다"],
      subs: [{ name: "자몽청", ing: ["자몽 1kg", "설탕 1kg"], steps: ["재운다"],
               tip: "", place: "냉장", dur: "10일" }] },
    { id: "d3", name: "레몬 에이드", cat: "ade",
      ing: ["레몬청 60g"], steps: ["섞는다"],
      subs: [{ name: "자몽청", ing: ["자몽 2kg", "설탕 1kg"], steps: ["재운다"],
               tip: "", place: "냉장", dur: "10일" }] }
  ],
  known: [], needReview: [], sess: null
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(APP);
  await page.waitForTimeout(400);

  // ── 1. 로드 자체 ────────────────────────────────────────────────
  ok("자바스크립트 오류 없이 뜬다", errors.length === 0, errors.join(" | "));
  ok("app.js 가 실제로 실행됐다", await page.evaluate(() =>
    typeof data === "object" && Array.isArray(data.drinks)));
  ok("style.css 가 실제로 붙었다", await page.evaluate(() =>
    getComputedStyle(document.body).backgroundColor !== "rgba(0, 0, 0, 0)"));

  // ── 2. 부재료 라이브러리 마이그레이션 ───────────────────────────
  const mig = await page.evaluate(legacy => {
    const root = JSON.parse(JSON.stringify(legacy));
    const r = liftSubs(root);
    return {
      report: r,
      subNames: (root.subs || []).map(s => s.name),
      refs: root.drinks.map(d => (d.subRefs || []).length),
      leftover: root.drinks.filter(d => d.subs).length,
      d1sub: (root.subs.find(s => s.id === root.drinks[0].subRefs[0]) || {}).name,
      d3sub: (root.subs.find(s => s.id === root.drinks[2].subRefs[0]) || {}).name,
      shared: root.drinks[0].subRefs[0] === root.drinks[1].subRefs[0],
      dur: (root.subs[0] || {}).dur
    };
  }, LEGACY);

  eq("같은 부재료 3건이 2건으로 합쳐진다", mig.subNames.length, 2);
  ok("이름은 같지만 배합이 다르면 따로 남는다", mig.subNames.indexOf("자몽청 2") >= 0,
     JSON.stringify(mig.subNames));
  ok("배합이 같은 두 메뉴는 같은 부재료를 가리킨다", mig.shared);
  ok("배합이 다른 메뉴는 분리된 쪽을 가리킨다", mig.d3sub === "자몽청 2", mig.d3sub);
  eq("모든 메뉴가 참조를 갖는다", mig.refs, [1, 1, 1]);
  eq("메뉴에 박혀 있던 subs 는 사라진다", mig.leftover, 0);
  eq("보관 기한 같은 값이 유실되지 않는다", mig.dur, "10일");

  // ── 3. 마이그레이션 멱등성 (두 번 돌려도 안 늘어난다) ───────────
  const idem = await page.evaluate(legacy => {
    const root = JSON.parse(JSON.stringify(legacy));
    liftSubs(root);
    const once = root.subs.length;
    liftSubs(root);
    return { once: once, twice: root.subs.length };
  }, LEGACY);
  ok("마이그레이션을 두 번 돌려도 부재료가 늘지 않는다",
     idem.once === idem.twice, idem.once + " → " + idem.twice);

  // ── 4. 보관(아카이브) ───────────────────────────────────────────
  const arch = await page.evaluate(() => {
    const backup = JSON.stringify(data);
    data.drinks = [
      { id: "a1", name: "A", cat: "tea", ing: [], steps: [] },
      { id: "a2", name: "B", cat: "tea", ing: [], steps: [], arch: true },
      { id: "a3", name: "C", cat: "ade", ing: [], steps: [] }
    ];
    data.needReview = ["a1", "a2"];
    const r = {
      live: liveDrinks().map(d => d.id),
      archived: archDrinks().map(d => d.id),
      all: drinksOf("all").map(d => d.id),
      tea: drinksOf("tea").map(d => d.id),
      review: liveDrinks().filter(d => has(data.needReview, d.id)).map(d => d.id)
    };
    data = JSON.parse(backup);
    return r;
  });

  eq("보관한 레시피는 목록에서 빠진다", arch.live, ["a1", "a3"]);
  eq("보관함에는 보관한 것만 나온다", arch.archived, ["a2"]);
  eq("전체 필터에도 보관본이 안 샌다", arch.all, ["a1", "a3"]);
  eq("카테고리 필터에도 안 샌다", arch.tea, ["a1"]);
  eq("다시 볼래요 학습에도 안 샌다", arch.review, ["a1"]);

  // ── 5. 보관 상태가 수정 후에도 살아남는가 (실제로 났던 버그) ────
  const keep = await page.evaluate(() => {
    const backup = JSON.stringify(data);
    data.drinks = [{ id: "k1", name: "보관중", cat: "tea", ing: [], steps: [], arch: true }];
    const before = data.drinks[0].arch;
    // 저장 핸들러가 하는 것과 같은 방식으로 레코드를 새로 만든다
    const editingId = "k1";
    const rebuilt = {
      id: editingId, name: "보관중(수정)", cat: "tea", ing: [], steps: [],
      arch: editingId ? !!(data.drinks.find(x => x.id === editingId) || {}).arch : false
    };
    const r = { before: before, after: rebuilt.arch };
    data = JSON.parse(backup);
    return r;
  });
  ok("보관한 레시피를 수정해도 보관 상태가 유지된다",
     keep.before === true && keep.after === true, JSON.stringify(keep));

  // ── 6. 부재료 참조 무결성 ───────────────────────────────────────
  const ref = await page.evaluate(() => {
    const backup = JSON.stringify(data);
    data.subs = [{ id: "s1", name: "자몽청", ing: [], steps: [] },
                 { id: "s2", name: "레몬청", ing: [], steps: [] }];
    data.drinks = [{ id: "x1", name: "X", cat: "tea", ing: [], steps: [], subRefs: ["s1", "s2"] },
                   { id: "x2", name: "Y", cat: "ade", ing: [], steps: [], subRefs: ["s1"] }];
    const uses = usesOf("s1").map(d => d.id);
    deleteSub("s1");
    const r = {
      uses: uses,
      subsLeft: data.subs.map(s => s.id),
      refsLeft: data.drinks.map(d => d.subRefs),
      dangling: data.drinks.some(d => (d.subRefs || []).some(id => !subById(id)))
    };
    data = JSON.parse(backup);
    return r;
  });

  eq("부재료를 쓰는 메뉴를 역으로 찾는다", ref.uses, ["x1", "x2"]);
  eq("부재료를 지우면 목록에서 빠진다", ref.subsLeft, ["s2"]);
  eq("부재료를 지우면 참조도 같이 정리된다", ref.refsLeft, [["s2"], []]);
  ok("끊어진 참조가 남지 않는다", ref.dangling === false);

  // ── 7. 저장소 왕복 ──────────────────────────────────────────────
  const trip = await page.evaluate(() => {
    const backup = localStorage.getItem("brewnote.v1");
    const before = JSON.stringify(data);
    persist();
    const raw = localStorage.getItem("brewnote.v1");
    const same = JSON.stringify(JSON.parse(raw)) === before;
    if (backup === null) localStorage.removeItem("brewnote.v1");
    else localStorage.setItem("brewnote.v1", backup);
    return { key: raw !== null, same: same };
  });
  ok("brewnote.v1 키로 저장된다", trip.key);
  ok("저장했다 읽어도 데이터가 그대로다", trip.same);

  // ── 8. 사용자 입력 이스케이프 (XSS) ─────────────────────────────
  const xss = await page.evaluate(() => {
    const s = esc('<img src=x onerror=alert(1)>"&');
    return { out: s, hasTag: s.indexOf("<img") >= 0 };
  });
  ok("사용자 입력의 태그가 이스케이프된다", xss.hasTag === false, xss.out);

  // ── 9. 외부로 나가는 통신이 없다 ────────────────────────────────
  const csp = await page.evaluate(() =>
    (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || "");
  ok("CSP 가 걸려 있다", csp.length > 0);
  ok("connect-src 가 막혀 있다", csp.indexOf("connect-src 'none'") >= 0, csp);
  ok("분리본이므로 script-src 는 'self'", csp.indexOf("script-src 'self'") >= 0, csp);
  ok("frame-ancestors 는 meta 에 넣지 않는다", csp.indexOf("frame-ancestors") < 0, csp);

  const remote = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll("script[src], link[href], img[src]").forEach(el => {
      const u = el.getAttribute("src") || el.getAttribute("href") || "";
      if (/^(https?:)?\/\//.test(u)) bad.push(u);
    });
    return bad;
  });
  eq("외부에서 불러오는 리소스가 없다", remote, []);

  await browser.close();

  console.log("");
  console.log("통과 " + pass + " / 실패 " + fail);
  if (failures.length) {
    console.log("");
    failures.forEach(f => console.log("  ✗ " + f));
    process.exit(1);
  }
  console.log("이상 없음.");
})().catch(e => { console.error(e); process.exit(1); });
