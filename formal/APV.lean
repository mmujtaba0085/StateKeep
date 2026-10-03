/-
  Anchor-Point Versioning (APV) -- machine-checked core results.
  Lean 4 core only (no Mathlib).  Checked with Lean 4.12.0.

  Structure of this file
    §0  counting / least-element utilities
    §1  model: actors, generic change-point "kinds", applicability, migration
    §2  generic routing theory (monotone progress, termination, completeness,
        configuration safety) -- proved once, for every selection rule that
        returns a time-minimal applicable change-point
    §3  scalar change-points: Acc, determinism (Thm 3.4), completeness (Thm 5.2)
    §4  parallel change-points: Acc_par, totality/determinism (Thm 7.4),
        registration rule (Def 7.5 / Prop 7.6)
    §5  combined routing Acc+ (new Def 7.7: earlier of the two, ties -> scalar)
    §6  collection frontier (Thm 8.1)
-/
set_option linter.unusedSectionVars false

namespace APV

/-! ## §0 Utilities -/

/-- number of list elements satisfying `p` -/
def cnt {α : Type} (p : α → Bool) : List α → Nat
  | [] => 0
  | a :: l => (if p a = true then 1 else 0) + cnt p l

theorem cnt_le_length {α : Type} (p : α → Bool) : ∀ l : List α, cnt p l ≤ l.length
  | [] => by simp [cnt]
  | a :: l => by
      have := cnt_le_length p l
      show (if p a = true then 1 else 0) + cnt p l ≤ l.length + 1
      split <;> omega

theorem cnt_mono {α : Type} (p q : α → Bool) :
    ∀ l : List α, (∀ y ∈ l, q y = true → p y = true) → cnt q l ≤ cnt p l
  | [], _ => by simp [cnt]
  | a :: l, h => by
      have ih := cnt_mono p q l (fun y hy => h y (List.mem_cons_of_mem _ hy))
      have ha := h a (List.mem_cons_self _ _)
      show (if q a = true then 1 else 0) + cnt q l ≤ (if p a = true then 1 else 0) + cnt p l
      by_cases hq : q a = true
      · rw [if_pos hq, if_pos (ha hq)]; omega
      · rw [if_neg hq]; split <;> omega

/-- strict decrease of a count when the predicate is strengthened and loses a witness -/
theorem cnt_lt {α : Type} (p q : α → Bool) :
    ∀ (l : List α) (y : α), (∀ z ∈ l, q z = true → p z = true) →
      y ∈ l → p y = true → q y = false → cnt q l < cnt p l
  | [], _, _, hy, _, _ => by cases hy
  | a :: l, y, h, hy, hp, hq => by
      have hm := cnt_mono p q l (fun z hz => h z (List.mem_cons_of_mem _ hz))
      have ha := h a (List.mem_cons_self _ _)
      show (if q a = true then 1 else 0) + cnt q l < (if p a = true then 1 else 0) + cnt p l
      cases hy with
      | head => rw [if_neg (by simp [hq]), if_pos hp]; omega
      | tail _ hy' =>
        have ih := cnt_lt p q l y (fun z hz => h z (List.mem_cons_of_mem _ hz)) hy' hp hq
        by_cases hqa : q a = true
        · rw [if_pos hqa, if_pos (ha hqa)]; omega
        · rw [if_neg hqa]; split <;> omega

theorem cnt_pos {α : Type} (p : α → Bool) :
    ∀ (l : List α) (y : α), y ∈ l → p y = true → 0 < cnt p l
  | [], _, hy, _ => by cases hy
  | a :: l, y, hy, hp => by
      show 0 < (if p a = true then 1 else 0) + cnt p l
      cases hy with
      | head => rw [if_pos hp]; omega
      | tail _ hy' => have := cnt_pos p l y hy' hp; omega

/-- least element of a list w.r.t. a Boolean preorder (first-found on ties) -/
def least {α : Type} (le : α → α → Bool) : List α → Option α
  | [] => none
  | a :: l =>
    match least le l with
    | none => some a
    | some b => if le a b = true then some a else some b

theorem least_none {α : Type} (le : α → α → Bool) :
    ∀ l : List α, least le l = none → l = []
  | [], _ => rfl
  | a :: l, h => by
      unfold least at h
      cases hl : least le l with
      | none => rw [hl] at h; cases h
      | some b => rw [hl] at h; dsimp only at h; split at h <;> cases h

theorem least_some {α : Type} (le : α → α → Bool)
    (htot : ∀ a b, le a b = true ∨ le b a = true)
    (htr : ∀ a b c, le a b = true → le b c = true → le a c = true) :
    ∀ (l : List α) (m : α), least le l = some m → m ∈ l ∧ ∀ z ∈ l, le m z = true
  | [], _, h => by cases h
  | a :: l, m, h => by
      have hrefl : le a a = true := by cases htot a a <;> assumption
      unfold least at h
      cases hl : least le l with
      | none =>
        rw [hl] at h; cases h
        have := least_none le l hl; subst this
        refine ⟨List.mem_cons_self _ _, ?_⟩
        intro z hz
        rcases List.mem_cons.mp hz with rfl | hz
        · exact hrefl
        · cases hz
      | some b =>
        rw [hl] at h; dsimp only at h
        have ⟨hbm, hbl⟩ := least_some le htot htr l b hl
        by_cases hab : le a b = true
        · rw [if_pos hab] at h; cases h
          refine ⟨List.mem_cons_self _ _, ?_⟩
          intro z hz
          rcases List.mem_cons.mp hz with rfl | hz
          · exact hrefl
          · exact htr _ _ _ hab (hbl z hz)
        · rw [if_neg hab] at h; cases h
          refine ⟨List.mem_cons_of_mem _ hbm, ?_⟩
          intro z hz
          rcases List.mem_cons.mp hz with rfl | hz
          · cases htot z m with
            | inl h' => exact absurd h' hab
            | inr h' => exact h'
          · exact hbl z hz

theorem least_isSome {α : Type} (le : α → α → Bool) (l : List α) (y : α) (hy : y ∈ l) :
    ∃ m, least le l = some m := by
  cases h : least le l with
  | none => have := least_none le l h; subst this; cases hy
  | some m => exact ⟨m, rfl⟩

/-- filtering by a weaker predicate first does not change a filter -/
theorem filter_filter_weaker {α : Type} (p q : α → Bool) :
    ∀ l : List α, (∀ x ∈ l, p x = true → q x = true) →
      (l.filter q).filter p = l.filter p
  | [], _ => rfl
  | a :: l, h => by
      have ih := filter_filter_weaker p q l (fun x hx => h x (List.mem_cons_of_mem _ hx))
      have ha := h a (List.mem_cons_self _ _)
      by_cases hp : p a = true
      · simp only [List.filter_cons, if_pos (ha hp), if_pos hp, ih]
      · by_cases hq : q a = true
        · simp only [List.filter_cons, if_pos hq, if_neg hp, ih]
        · simp only [List.filter_cons, if_neg hq, if_neg hp, ih]

/-! ## §1 Model -/

inductive Status
  | active
  | finished
  | stranded
  deriving DecidableEq, Repr

/-- Actor (Def 2.1).  The transition history is represented by its fingerprint `fp`
    (theorems are about exact fingerprints, i.e. the paper's "exact histories");
    `keys` is the regional set `K_a` used by parallel selectors (§7). -/
structure Actor (Def Cfg Ctx FP Key : Type) where
  d    : Def
  q    : Cfg
  x    : Ctx
  fp   : FP
  keys : List Key
  ell  : Nat
  st   : Status

/-- A *kind* of change-point: how to read its family, time, target and match
    predicate.  Scalar, parallel and combined change-points are three kinds. -/
structure Kind (Fam Def FP Key X : Type) where
  fam : X → Fam
  t   : X → Nat
  tgt : X → Def
  mt  : X → FP → List Key → Bool

section Generic
variable {Fam Def Cfg Ctx FP Key X : Type} [DecidableEq Fam]
variable (wff : Def → Fam) (K : Kind Fam Def FP Key X)

/-- applicability of change-point `c` to actor `a` (Def 3.3, without registry membership) -/
def applies (a : Actor Def Cfg Ctx FP Key) (c : X) : Bool :=
  decide (K.fam c = wff a.d) && decide (a.ell ≤ K.t c) && K.mt c a.fp a.keys &&
    decide (a.st ≠ Status.finished)

theorem applies_iff (a : Actor Def Cfg Ctx FP Key) (c : X) :
    applies wff K a c = true ↔
      K.fam c = wff a.d ∧ a.ell ≤ K.t c ∧ K.mt c a.fp a.keys = true ∧ a.st ≠ Status.finished := by
  simp [applies, and_assoc]

/-- `c ∈ App(a)` for registry `R` -/
def App (R : List X) (a : Actor Def Cfg Ctx FP Key) (c : X) : Prop :=
  c ∈ R ∧ applies wff K a c = true

/-- a selection rule is *time-minimal* on registry `R`: it returns an applicable
    change-point of least time, and `none` only if nothing applies. -/
def SelOK (R : List X) (sel : Actor Def Cfg Ctx FP Key → Option X) : Prop :=
  ∀ a, (∀ c, sel a = some c → App wff K R a c ∧ ∀ c', App wff K R a c' → K.t c ≤ K.t c') ∧
       (sel a = none → ∀ c, ¬ App wff K R a c)

/-- registry well-formedness from Def 3.1: the target of a change-point is in its family -/
def RegWF (R : List X) : Prop := ∀ c ∈ R, wff (K.tgt c) = K.fam c

variable (μ : Def → Cfg → Option Cfg) (τ : Def → Ctx → Option Ctx)

/-- Migration / stranding (Def 3.4): `d := tgt c`, `ℓ := t_c + 1`, history unchanged;
    configuration and context are mapped if both `μ` and `τ` are defined, otherwise the
    actor is stranded and keeps its configuration. -/
def migrate (c : X) (a : Actor Def Cfg Ctx FP Key) : Actor Def Cfg Ctx FP Key :=
  match μ (K.tgt c) a.q, τ (K.tgt c) a.x with
  | some q', some x' => { a with d := K.tgt c, ell := K.t c + 1, q := q', x := x', st := .active }
  | _, _ => { a with d := K.tgt c, ell := K.t c + 1, st := .stranded }

theorem migrate_d (c : X) (a : Actor Def Cfg Ctx FP Key) : (migrate K μ τ c a).d = K.tgt c := by
  unfold migrate; split <;> rfl
theorem migrate_ell (c : X) (a : Actor Def Cfg Ctx FP Key) : (migrate K μ τ c a).ell = K.t c + 1 := by
  unfold migrate; split <;> rfl
theorem migrate_fp (c : X) (a : Actor Def Cfg Ctx FP Key) : (migrate K μ τ c a).fp = a.fp := by
  unfold migrate; split <;> rfl
theorem migrate_keys (c : X) (a : Actor Def Cfg Ctx FP Key) : (migrate K μ τ c a).keys = a.keys := by
  unfold migrate; split <;> rfl
theorem migrate_st (c : X) (a : Actor Def Cfg Ctx FP Key) :
    (migrate K μ τ c a).st = .active ∨ (migrate K μ τ c a).st = .stranded := by
  unfold migrate; split
  · exact Or.inl rfl
  · exact Or.inr rfl
/-- the actor becomes active only when `μ` is defined on its configuration, and then
    its new configuration is `μ`'s value -/
theorem migrate_active (c : X) (a : Actor Def Cfg Ctx FP Key) :
    (migrate K μ τ c a).st = .active → μ (K.tgt c) a.q = some (migrate K μ τ c a).q := by
  unfold migrate; split
  · rename_i q' x' h1 _; intro; simp [h1]
  · intro h; cases h

/-! ### Chains of hops and routing units -/

/-- a sequence of routing hops chosen by `sel` (no event steps in between) -/
inductive Chain (sel : Actor Def Cfg Ctx FP Key → Option X) :
    Actor Def Cfg Ctx FP Key → List X → Actor Def Cfg Ctx FP Key → Prop
  | nil (a) : Chain sel a [] a
  | cons (a c b cs e) : sel a = some c → b = migrate K μ τ c a → Chain sel b cs e →
      Chain sel a (c :: cs) e

/-- one *complete* routing phase of a unit (Assumption 3.5): repeated migration until
    `sel = none` (fixpoint) or until a hop strands the actor.  Not cut off by any hop bound. -/
inductive UChain (sel : Actor Def Cfg Ctx FP Key → Option X) :
    Actor Def Cfg Ctx FP Key → List X → Actor Def Cfg Ctx FP Key → Prop
  | fix (a) : sel a = none → UChain sel a [] a
  | strand (a c b) : sel a = some c → b = migrate K μ τ c a → b.st = .stranded →
      UChain sel a [c] b
  | step (a c b cs e) : sel a = some c → b = migrate K μ τ c a → b.st = .active →
      UChain sel b cs e → UChain sel a (c :: cs) e

theorem UChain.toChain {sel : Actor Def Cfg Ctx FP Key → Option X} {a cs e}
    (h : UChain K μ τ sel a cs e) : Chain K μ τ sel a cs e := by
  induction h with
  | fix a _ => exact .nil a
  | strand a c b hs hb _ => exact .cons a c b [] b hs hb (.nil b)
  | step a c b cs e hs hb _ _ ih => exact .cons a c b cs e hs hb ih

/-- routing with a hop budget (the implementation's bound, e.g. 32) -/
def routeU (sel : Actor Def Cfg Ctx FP Key → Option X) :
    Nat → Actor Def Cfg Ctx FP Key → List X × Actor Def Cfg Ctx FP Key
  | 0, a => ([], a)
  | n + 1, a =>
    match sel a with
    | none => ([], a)
    | some c =>
      if (migrate K μ τ c a).st = .stranded then ([c], migrate K μ τ c a)
      else (c :: (routeU sel n (migrate K μ τ c a)).1, (routeU sel n (migrate K μ τ c a)).2)

/-! ## §2 Generic routing theory -/

variable {R : List X} {sel : Actor Def Cfg Ctx FP Key → Option X}

/-- **Lemma 4.1 (migration advances logical time).** -/
theorem hop_advances (hsel : SelOK wff K R sel) {a : Actor Def Cfg Ctx FP Key} {c : X}
    (hs : sel a = some c) :
    a.ell ≤ K.t c ∧ (migrate K μ τ c a).ell = K.t c + 1 ∧ a.ell < (migrate K μ τ c a).ell := by
  have hA := ((hsel a).1 c hs).1
  have := ((applies_iff wff K a c).mp hA.2).2.1
  rw [migrate_ell]; omega

/-- a hop keeps the actor in its family (needs `RegWF`) -/
theorem hop_family (hsel : SelOK wff K R sel) (hwf : RegWF wff K R)
    {a : Actor Def Cfg Ctx FP Key} {c : X} (hs : sel a = some c) :
    wff (migrate K μ τ c a).d = wff a.d := by
  have hA := ((hsel a).1 c hs).1
  rw [migrate_d, hwf c hA.1]
  exact ((applies_iff wff K a c).mp hA.2).1

theorem chain_family (hsel : SelOK wff K R sel) (hwf : RegWF wff K R)
    {a cs e} (h : Chain K μ τ sel a cs e) : wff e.d = wff a.d := by
  induction h with
  | nil => rfl
  | cons a c b cs e hs hb _ ih => rw [ih, hb]; exact hop_family wff K μ τ hsel hwf hs

/-- **Thm 4.2 (a)/(b)/(c), within one chain.**  Logical time grows, every change-point
    used lies in the registry at or after the start time, the times of the change-points
    used are strictly increasing (so no change-point -- indeed no (family,time) and hence
    no location -- is used twice), and each lies below the final logical time. -/
theorem chain_progress (hsel : SelOK wff K R sel) {a cs e} (h : Chain K μ τ sel a cs e) :
    a.ell ≤ e.ell ∧ (∀ c ∈ cs, c ∈ R ∧ a.ell ≤ K.t c ∧ K.t c < e.ell) ∧
      cs.Pairwise (fun c c' => K.t c < K.t c') := by
  induction h with
  | nil => exact ⟨Nat.le_refl _, ⟨fun _ h => (List.not_mem_nil _ h).elim, List.Pairwise.nil⟩⟩
  | cons a c b cs e hs hb _ ih =>
    obtain ⟨ih1, ih2, ih3⟩ := ih
    have ⟨h1, h2, h3⟩ := hop_advances wff K μ τ hsel hs
    have hcR := ((hsel a).1 c hs).1.1
    subst hb
    refine ⟨by omega, ?_, ?_⟩
    · intro c' hc'
      rcases List.mem_cons.mp hc' with rfl | hc'
      · exact ⟨hcR, h1, by omega⟩
      · have := ih2 c' hc'; exact ⟨this.1, by omega, this.2.2⟩
    · refine List.Pairwise.cons ?_ ih3
      intro c' hc'; have := ih2 c' hc'; omega

theorem chain_nodup (hsel : SelOK wff K R sel) {a cs e} (h : Chain K μ τ sel a cs e) :
    cs.Nodup :=
  (chain_progress wff K μ τ hsel h).2.2.imp (fun {x y} hxy hxy' => by subst hxy'; omega)

/-- change-points of family `f` at or after logical time `l` -/
def pend (f : Fam) (l : Nat) (c : X) : Bool := decide (K.fam c = f) && decide (l ≤ K.t c)

/-- one hop strictly decreases the number of pending change-points of the family -/
theorem hop_pend_lt (hsel : SelOK wff K R sel) (hwf : RegWF wff K R)
    {a : Actor Def Cfg Ctx FP Key} {c : X} (hs : sel a = some c) :
    cnt (pend K (wff (migrate K μ τ c a).d) (migrate K μ τ c a).ell) R <
      cnt (pend K (wff a.d) a.ell) R := by
  have hA := ((hsel a).1 c hs).1
  have hap := (applies_iff wff K a c).mp hA.2
  have hfam := hop_family wff K μ τ hsel hwf hs
  have hl := migrate_ell K μ τ c a
  rw [hfam, hl]
  apply cnt_lt _ _ R c _ hA.1
  · simp [pend, hap.1, hap.2.1]
  · simp [pend]
  · intro z _ hz
    simp [pend] at hz ⊢
    exact ⟨hz.1, by omega⟩

/-- **Thm 4.2 (c), hop bound by change-points:** a chain has at most as many hops as
    there are change-points of the actor's family at or after its logical time
    (in particular at most `|R|`). -/
theorem chain_length_le (hsel : SelOK wff K R sel) (hwf : RegWF wff K R)
    {a cs e} (h : Chain K μ τ sel a cs e) :
    cs.length + cnt (pend K (wff e.d) e.ell) R ≤ cnt (pend K (wff a.d) a.ell) R := by
  induction h with
  | nil => simp
  | cons a c b cs e hs hb _ ih =>
    have := hop_pend_lt wff K μ τ hsel hwf hs
    subst hb; simp only [List.length_cons]; omega

theorem chain_length_le_R (hsel : SelOK wff K R sel) (hwf : RegWF wff K R)
    {a cs e} (h : Chain K μ τ sel a cs e) : cs.length ≤ R.length := by
  have := chain_length_le wff K μ τ hsel hwf h
  have := cnt_le_length (pend K (wff a.d) a.ell) R
  omega

/-- largest time in the registry -/
def maxT (R : List X) : Nat := R.foldr (fun c m => max (K.t c) m) 0

theorem le_maxT : ∀ (R : List X), ∀ c ∈ R, K.t c ≤ maxT K R
  | [], _, h => by cases h
  | a :: l, c, h => by
      have ih := le_maxT l
      show K.t c ≤ max (K.t a) (maxT K l)
      rcases List.mem_cons.mp h with rfl | h
      · exact Nat.le_max_left _ _
      · exact Nat.le_trans (ih c h) (Nat.le_max_right _ _)

/-- number of distinct deployment times of family `f` at or after `l`
    (= number of locations of the family at or after `l`, under "one location per
    (family,time)"; in general it is at most the number of locations). -/
def pendTimes (R : List X) (f : Fam) (l : Nat) : Nat :=
  cnt (fun n => decide (l ≤ n) && R.any (fun c => decide (K.fam c = f) && decide (K.t c = n)))
    (List.range (maxT K R + 1))

theorem hop_pendTimes_lt (hsel : SelOK wff K R sel) (hwf : RegWF wff K R)
    {a : Actor Def Cfg Ctx FP Key} {c : X} (hs : sel a = some c) :
    pendTimes K R (wff (migrate K μ τ c a).d) (migrate K μ τ c a).ell <
      pendTimes K R (wff a.d) a.ell := by
  have hA := ((hsel a).1 c hs).1
  have hap := (applies_iff wff K a c).mp hA.2
  have hfam := hop_family wff K μ τ hsel hwf hs
  have hl := migrate_ell K μ τ c a
  rw [hfam, hl]
  unfold pendTimes
  apply cnt_lt _ _ _ (K.t c)
  · intro z _ hz
    simp only [Bool.and_eq_true, decide_eq_true_eq] at hz ⊢
    exact ⟨by omega, hz.2⟩
  · exact List.mem_range.mpr (Nat.lt_succ_of_le (le_maxT K R c hA.1))
  · simp only [Bool.and_eq_true, decide_eq_true_eq, List.any_eq_true]
    exact ⟨hap.2.1, c, hA.1, by simp [hap.1]⟩
  · have : ¬ (K.t c + 1 ≤ K.t c) := by omega
    simp [this]

/-- **Thm 4.2 (c), paper form:** hops ≤ number of distinct pending times (≤ locations). -/
theorem chain_length_le_times (hsel : SelOK wff K R sel) (hwf : RegWF wff K R)
    {a cs e} (h : Chain K μ τ sel a cs e) :
    cs.length ≤ pendTimes K R (wff a.d) a.ell := by
  suffices cs.length + pendTimes K R (wff e.d) e.ell ≤ pendTimes K R (wff a.d) a.ell by omega
  induction h with
  | nil => simp
  | cons a c b cs e hs hb _ ih =>
    have := hop_pendTimes_lt wff K μ τ hsel hwf hs
    subst hb; simp only [List.length_cons]; omega

/-- **Termination (Thm 4.2 (c)):** with a hop budget of at least the number of pending
    change-points (e.g. `|R|`), `routeU` performs a *complete* routing phase: it ends at a
    fixpoint or at a stranding hop, never at the budget. -/
theorem routeU_complete (hsel : SelOK wff K R sel) (hwf : RegWF wff K R) :
    ∀ (n : Nat) (a : Actor Def Cfg Ctx FP Key), cnt (pend K (wff a.d) a.ell) R ≤ n →
      UChain K μ τ sel a (routeU K μ τ sel n a).1 (routeU K μ τ sel n a).2
  | 0, a, hn => by
      cases hs : sel a with
      | none => exact .fix a hs
      | some c =>
        exfalso
        have hA := ((hsel a).1 c hs).1
        have hap := (applies_iff wff K a c).mp hA.2
        have := cnt_pos (pend K (wff a.d) a.ell) R c hA.1 (by simp [pend, hap.1, hap.2.1])
        omega
  | n + 1, a, hn => by
      cases hs : sel a with
      | none => simp only [routeU, hs]; exact .fix a hs
      | some c =>
        simp only [routeU, hs]
        by_cases hb : (migrate K μ τ c a).st = .stranded
        · rw [if_pos hb]; exact .strand a c _ hs rfl hb
        · rw [if_neg hb]
          have hact : (migrate K μ τ c a).st = .active := by
            rcases migrate_st K μ τ c a with h | h
            · exact h
            · exact absurd h hb
          have hlt := hop_pend_lt wff K μ τ hsel hwf hs
          exact .step a c _ _ _ hs rfl hact (routeU_complete hsel hwf n _ (by omega))

theorem routeU_complete_R (hsel : SelOK wff K R sel) (hwf : RegWF wff K R)
    (a : Actor Def Cfg Ctx FP Key) :
    UChain K μ τ sel a (routeU K μ τ sel R.length a).1 (routeU K μ τ sel R.length a).2 :=
  routeU_complete wff K μ τ hsel hwf R.length a (cnt_le_length _ R)

/-- **Generic completeness (core of Thm 5.2).**  Let `c ∈ R` be applicable to the actor
    at the start of a complete routing phase.  Then some hop of the phase, taken in a
    state `a'` in which `c` is *still applicable*, goes through a change-point `c'` with
    `t_{c'} = t_c`; or the actor is stranded after hops that are all strictly earlier
    than `t_c`. -/
theorem complete_generic (hsel : SelOK wff K R sel) (hwf : RegWF wff K R)
    {a cs e} (hu : UChain K μ τ sel a cs e) {c : X} (hc : App wff K R a c) :
    (∃ a' c', c' ∈ cs ∧ sel a' = some c' ∧ App wff K R a' c ∧ K.t c' = K.t c) ∨
    (e.st = .stranded ∧ ∀ c' ∈ cs, K.t c' < K.t c) := by
  induction hu with
  | fix a hs => exact absurd hc ((hsel a).2 hs c)
  | strand a c' b hs hb hst =>
    have hle := ((hsel a).1 c' hs).2 c hc
    by_cases heq : K.t c' = K.t c
    · exact Or.inl ⟨a, c', List.mem_cons_self _ _, hs, hc, heq⟩
    · refine Or.inr ⟨hst, ?_⟩
      intro z hz; rcases List.mem_cons.mp hz with rfl | hz
      · omega
      · cases hz
  | step a c' b cs e hs hb hst _ ih =>
    have hle := ((hsel a).1 c' hs).2 c hc
    by_cases heq : K.t c' = K.t c
    · exact Or.inl ⟨a, c', List.mem_cons_self _ _, hs, hc, heq⟩
    · -- c is still applicable after the hop
      have hcb : App wff K R b c := by
        have hap := (applies_iff wff K a c).mp hc.2
        refine ⟨hc.1, (applies_iff wff K b c).mpr ⟨?_, ?_, ?_, ?_⟩⟩
        · rw [hb, hop_family wff K μ τ hsel hwf hs]; exact hap.1
        · rw [hb, migrate_ell]; omega
        · rw [hb, migrate_fp, migrate_keys]; exact hap.2.2.1
        · rw [hst]; intro h; cases h
      rcases ih hcb with ⟨a', c'', hm, h1, h2, h3⟩ | ⟨h1, h2⟩
      · exact Or.inl ⟨a', c'', List.mem_cons_of_mem _ hm, h1, h2, h3⟩
      · refine Or.inr ⟨h1, ?_⟩
        intro z hz; rcases List.mem_cons.mp hz with rfl | hz
        · omega
        · exact h2 z hz

/-! ### Runs: hops interleaved with event steps (registry may change between units) -/

variable {Ev : Type} (δ : Def → Cfg → Ev → Ctx → Option (Cfg × Ctx))
  (final : Def → Cfg → Bool) (hfp : FP → Ev → FP) (upk : Def → Cfg → List Key → Ev → List Key)

/-- an event step (§2): only active actors, only enabled events; `d` and `ℓ` unchanged -/
inductive EvStep : Actor Def Cfg Ctx FP Key → Actor Def Cfg Ctx FP Key → Prop
  | mk (a : Actor Def Cfg Ctx FP Key) (e : Ev) (q' : Cfg) (x' : Ctx) :
      a.st = .active → δ a.d a.q e a.x = some (q', x') →
      EvStep a { a with q := q', x := x', fp := hfp a.fp e, keys := upk a.d q' a.keys e,
                        st := if final a.d q' then .finished else .active }

/-- An arbitrary run of one actor: hops through any change-point that was applicable
    w.r.t. *some* registry at that moment (`a.ell ≤ t_c`), interleaved with event steps.
    The list records the change-points used. -/
inductive Run : Actor Def Cfg Ctx FP Key → List X → Actor Def Cfg Ctx FP Key → Prop
  | refl (a) : Run a [] a
  | hop (a c b cs e) : a.ell ≤ K.t c → b = migrate K μ τ c a → Run b cs e → Run a (c :: cs) e
  | ev (a b cs e) : EvStep δ final hfp upk a b → Run b cs e → Run a cs e

/-- **Thm 4.2 (a)(b)(c) over whole runs:** logical time never decreases, and over the
    whole life of an actor the change-points it is routed through have strictly
    increasing times -- so no change-point (and no location) is used twice. -/
theorem run_progress {a cs e} (h : Run K μ τ δ final hfp upk a cs e) :
    a.ell ≤ e.ell ∧ (∀ c ∈ cs, a.ell ≤ K.t c ∧ K.t c < e.ell) ∧
      cs.Pairwise (fun c c' => K.t c < K.t c') := by
  induction h with
  | refl => exact ⟨Nat.le_refl _, ⟨fun _ h => (List.not_mem_nil _ h).elim, List.Pairwise.nil⟩⟩
  | hop a c b cs e hle hb _ ih =>
    obtain ⟨ih1, ih2, ih3⟩ := ih
    have hl : b.ell = K.t c + 1 := by rw [hb, migrate_ell]
    refine ⟨by omega, ?_, ?_⟩
    · intro c' hc'
      rcases List.mem_cons.mp hc' with rfl | hc'
      · exact ⟨hle, by omega⟩
      · have := ih2 c' hc'; exact ⟨by omega, this.2⟩
    · refine List.Pairwise.cons ?_ ih3
      intro c' hc'; have := ih2 c' hc'; omega
  | ev a b cs e hev _ ih =>
    cases hev with
    | mk ev q' x' _ _ => exact ih

theorem run_nodup {a cs e} (h : Run K μ τ δ final hfp upk a cs e) : cs.Nodup :=
  (run_progress K μ τ δ final hfp upk h).2.2.imp (fun {x y} hxy hxy' => by subst hxy'; omega)

/-- invariant (I): `ℓ_a ≥ dep(d_a) + 1` is preserved, given `dep(tgt c) = t_c` -/
theorem run_invI (dep : Def → Nat) (hdep : ∀ c : X, dep (K.tgt c) = K.t c)
    {a cs e} (h : Run K μ τ δ final hfp upk a cs e) : dep a.d + 1 ≤ a.ell → dep e.d + 1 ≤ e.ell := by
  induction h with
  | refl => exact id
  | hop a c b _ _ _ hb _ ih =>
    intro _; apply ih; rw [hb, migrate_d, migrate_ell, hdep]; exact Nat.le_refl _
  | ev a b cs e hev _ ih =>
    cases hev with
    | mk ev q' x' _ _ => exact ih

/-- **Thm 6.1 (configuration safety).**  Valid configurations are a predicate per
    definition.  If every state mapping maps into valid configurations of its target
    definition and every transition function stays inside valid configurations, then
    every active actor always has a valid configuration of its current definition. -/
theorem run_safe (valid : Def → Cfg → Prop)
    (hμ : ∀ d q q', μ d q = some q' → valid d q')
    (hδ : ∀ d q e x q' x', δ d q e x = some (q', x') → valid d q')
    {a cs e} (h : Run K μ τ δ final hfp upk a cs e) :
    (a.st = .active → valid a.d a.q) → (e.st = .active → valid e.d e.q) := by
  induction h with
  | refl => exact id
  | hop a c b _ _ _ hb _ ih =>
    intro _; apply ih; intro hact
    rw [hb] at hact ⊢
    rw [migrate_d]
    exact hμ _ _ _ (migrate_active K μ τ c a hact)
  | ev a b cs e hev _ ih =>
    intro _; apply ih
    cases hev with
    | mk ev q' x' _ hd =>
      intro _; exact hδ _ _ _ _ _ _ hd

/-- a spawned actor starts valid; with `run_safe`: every reachable active actor is valid -/
theorem spawn_safe (valid : Def → Cfg → Prop) (q0 : Def → Cfg) (hq0 : ∀ d, valid d (q0 d))
    (hμ : ∀ d q q', μ d q = some q' → valid d q')
    (hδ : ∀ d q e x q' x', δ d q e x = some (q', x') → valid d q')
    (a : Actor Def Cfg Ctx FP Key) (ha : a.q = q0 a.d) {cs e}
    (h : Run K μ τ δ final hfp upk a cs e) : e.st = .active → valid e.d e.q :=
  run_safe K μ τ δ final hfp upk valid hμ hδ h (fun _ => ha ▸ hq0 a.d)

/-- only active actors take event steps (by construction) -/
theorem evStep_active {a b} (h : EvStep δ final hfp upk a b) : a.st = .active := by
  cases h; assumption

/-- routing hops chosen by a time-minimal rule are `Run` hops -/
theorem chain_run (hsel : SelOK wff K R sel) {a cs e} (h : Chain K μ τ sel a cs e) :
    Run K μ τ δ final hfp upk a cs e := by
  induction h with
  | nil => exact .refl _
  | cons a c b cs e hs hb _ ih => exact .hop a c b cs e (hop_advances wff K μ τ hsel hs).1 hb ih

/-! ### Pruning (generic part of Thm 8.1) -/

/-- remove the change-points of family `f` with time `< Φ` -/
def prune (f : Fam) (Φ : Nat) (R : List X) : List X :=
  R.filter (fun c => !(decide (K.fam c = f)) || decide (Φ ≤ K.t c))

theorem prune_applicable (f : Fam) (Φ : Nat) (R : List X) (a : Actor Def Cfg Ctx FP Key)
    (hΦ : wff a.d = f → Φ ≤ a.ell) :
    (prune K f Φ R).filter (applies wff K a) = R.filter (applies wff K a) := by
  apply filter_filter_weaker
  intro c _ hc
  have hap := (applies_iff wff K a c).mp hc
  by_cases hf : K.fam c = f
  · have := hΦ (hap.1 ▸ hf)
    simp [hf]; omega
  · simp [hf]

end Generic

/-! ## §3 Scalar change-points (Sections 3–5) -/

inductive Pat (FP : Type)
  | exact (h : FP)
  | wild

/-- `a` matches `π` (Def 3.2): wildcard, or equal (exact) fingerprint -/
def Pat.matches {FP : Type} [DecidableEq FP] : Pat FP → FP → Bool
  | .wild, _ => true
  | .exact h, fp => decide (h = fp)

/-- `-spec`: exact patterns (0) come before the wildcard (1) -/
def Pat.rk {FP : Type} : Pat FP → Nat
  | .exact _ => 0
  | .wild => 1

theorem Pat.eq_of_rk_matches {FP : Type} [DecidableEq FP] {p1 p2 : Pat FP} {fp : FP}
    (hr : p1.rk = p2.rk) (h1 : p1.matches fp = true) (h2 : p2.matches fp = true) : p1 = p2 := by
  cases p1 with
  | wild => cases p2 with
    | wild => rfl
    | exact h => simp [Pat.rk] at hr
  | exact h => cases p2 with
    | wild => simp [Pat.rk] at hr
    | exact h' =>
      simp only [Pat.matches, decide_eq_true_eq] at h1 h2
      rw [h1, h2]

/-- scalar change-point `(f, t, π, r, d')` (Def 3.1); its location is `(f, t, π)` -/
structure CP (Fam Def FP : Type) where
  fam : Fam
  t   : Nat
  pat : Pat FP
  r   : Nat
  tgt : Def

section Scalar
variable {Fam Def Cfg Ctx FP Key : Type} [DecidableEq Fam] [DecidableEq FP]
variable (wff : Def → Fam)

def scK (Key : Type) : Kind Fam Def FP Key (CP Fam Def FP) where
  fam := CP.fam
  t := CP.t
  tgt := CP.tgt
  mt := fun c fp _ => c.pat.matches fp

/-- lexicographic order on `(t_c, -spec(π_c), -r_c)` -/
def leS (c1 c2 : CP Fam Def FP) : Prop :=
  c1.t < c2.t ∨ (c1.t = c2.t ∧ (c1.pat.rk < c2.pat.rk ∨ (c1.pat.rk = c2.pat.rk ∧ c2.r ≤ c1.r)))

instance (c1 c2 : CP Fam Def FP) : Decidable (leS c1 c2) := by unfold leS; infer_instance

def leSb (c1 c2 : CP Fam Def FP) : Bool := decide (leS c1 c2)

theorem leS_total (c1 c2 : CP Fam Def FP) : leS c1 c2 ∨ leS c2 c1 := by unfold leS; omega
theorem leS_trans {c1 c2 c3 : CP Fam Def FP} : leS c1 c2 → leS c2 c3 → leS c1 c3 := by
  unfold leS; omega
theorem leSb_total (c1 c2 : CP Fam Def FP) : leSb c1 c2 = true ∨ leSb c2 c1 = true := by
  simp only [leSb, decide_eq_true_eq]; exact leS_total c1 c2
theorem leSb_trans (c1 c2 c3 : CP Fam Def FP) :
    leSb c1 c2 = true → leSb c2 c3 = true → leSb c1 c3 = true := by
  simp only [leSb, decide_eq_true_eq]; exact leS_trans

/-- **Def 3.3:** `Acc(a)` = least applicable scalar change-point (`none` = ⊥, stay) -/
def acc (R : List (CP Fam Def FP)) (a : Actor Def Cfg Ctx FP Key) : Option (CP Fam Def FP) :=
  least leSb (R.filter (applies wff (scK Key) a))

/-- `c` is a least element of `App(a)` -/
def IsLeastS (R : List (CP Fam Def FP)) (a : Actor Def Cfg Ctx FP Key) (c : CP Fam Def FP) : Prop :=
  App wff (scK Key) R a c ∧ ∀ c', App wff (scK Key) R a c' → leS c c'

theorem acc_spec (R : List (CP Fam Def FP)) (a : Actor Def Cfg Ctx FP Key) :
    (∀ c, acc wff R a = some c → IsLeastS wff R a c) ∧
    (acc wff R a = none → ∀ c, ¬ App wff (scK Key) R a c) := by
  constructor
  · intro c h
    have ⟨hm, hl⟩ := least_some leSb leSb_total leSb_trans _ c h
    refine ⟨List.mem_filter.mp hm, fun c' hc' => ?_⟩
    have := hl c' (List.mem_filter.mpr hc')
    simpa [leSb] using this
  · intro h c hc
    have := least_none leSb _ h
    have hm : c ∈ R.filter (applies wff (scK Key) a) := List.mem_filter.mpr hc
    rw [this] at hm; cases hm

theorem acc_selOK (R : List (CP Fam Def FP)) :
    SelOK wff (scK Key) R (acc (Cfg := Cfg) (Ctx := Ctx) wff R) := by
  intro a
  refine ⟨fun c h => ?_, (acc_spec wff R a).2⟩
  have ⟨h1, h2⟩ := (acc_spec wff R a).1 c h
  refine ⟨h1, fun c' hc' => ?_⟩
  have := h2 c' hc'
  show c.t ≤ c'.t
  unfold leS at this; omega

/-- registry condition 1: no two change-points share a location and a refinement index -/
def RegUniq (R : List (CP Fam Def FP)) : Prop :=
  ∀ c1 ∈ R, ∀ c2 ∈ R, c1.fam = c2.fam → c1.t = c2.t → c1.pat = c2.pat → c1.r = c2.r → c1 = c2

/-- registry condition 2: each (family, time) holds at most one location -/
def OneLoc (R : List (CP Fam Def FP)) : Prop :=
  ∀ c1 ∈ R, ∀ c2 ∈ R, c1.fam = c2.fam → c1.t = c2.t → c1.pat = c2.pat

theorem scK_applies (a : Actor Def Cfg Ctx FP Key) (c : CP Fam Def FP) :
    applies wff (scK Key) a c = true ↔
      c.fam = wff a.d ∧ a.ell ≤ c.t ∧ c.pat.matches a.fp = true ∧ a.st ≠ .finished :=
  applies_iff wff (scK Key) a c

/-- **Thm 3.4 (Determinism).**  Any two least applicable change-points are equal, so
    `Acc` is well defined.  Only registry condition 1 is needed. -/
theorem determinism {R : List (CP Fam Def FP)} (hR : RegUniq R) {a : Actor Def Cfg Ctx FP Key}
    {c1 c2 : CP Fam Def FP} (h1 : IsLeastS wff R a c1) (h2 : IsLeastS wff R a c2) : c1 = c2 := by
  have l12 := h1.2 c2 h2.1
  have l21 := h2.2 c1 h1.1
  have ht : c1.t = c2.t ∧ c1.pat.rk = c2.pat.rk ∧ c1.r = c2.r := by unfold leS at l12 l21; omega
  have a1 := (scK_applies wff a c1).mp h1.1.2
  have a2 := (scK_applies wff a c2).mp h2.1.2
  have hp : c1.pat = c2.pat := Pat.eq_of_rk_matches ht.2.1 a1.2.2.1 a2.2.2.1
  exact hR c1 h1.1.1 c2 h2.1.1 (a1.1.trans a2.1.symm) ht.1 hp ht.2.2

/-- `acc` returns exactly the (unique) least applicable change-point -/
theorem acc_eq_iff {R : List (CP Fam Def FP)} (hR : RegUniq R) (a : Actor Def Cfg Ctx FP Key)
    (c : CP Fam Def FP) : acc wff R a = some c ↔ IsLeastS wff R a c := by
  constructor
  · exact (acc_spec wff R a).1 c
  · intro hc
    have ⟨m, hm⟩ := least_isSome leSb _ c (List.mem_filter.mpr hc.1)
    have : m = c := determinism wff hR ((acc_spec wff R a).1 m hm) hc
    rw [← this]; exact hm

variable {Cfg Ctx : Type} (μ : Def → Cfg → Option Cfg) (τ : Def → Ctx → Option Ctx)

/-- **Thm 5.2 (Completeness), scalar routing.**
    Serialization (Assumption 3.5) is the hypothesis `hser`: the first unit after the
    commit starts from the actor's state *at the commit* (commits fall between units, no
    event step intervenes), and its routing phase runs before its event (`hu` is a pure
    routing phase).  Visibility (Assumption 3.6) is `hvis : c ∈ R` for the registry `R`
    used by that unit.  `c ∈ Pop(c)` and invariant (D) are `hst hfam hmatch hD`.
    "Not cut off by the hop bound" is `hu` being a complete phase (see `routeU_complete`).
    Conclusion: the actor is routed through `c`'s location, to `d'_c` or a later
    refinement (`r ≥ r_c`), or is stranded at a hop strictly earlier than `t_c`. -/
theorem completeness_scalar {R : List (CP Fam Def FP)}
    (hwf : RegWF wff (scK Key) R) (hloc : OneLoc R)
    (aCommit aStart : Actor Def Cfg Ctx FP Key) (hser : aStart = aCommit)
    (c : CP Fam Def FP) (hvis : c ∈ R)
    (hst : aCommit.st ≠ .finished) (hfam : c.fam = wff aCommit.d)
    (hmatch : c.pat.matches aCommit.fp = true) (hD : aCommit.ell ≤ c.t)
    {cs : List (CP Fam Def FP)} {e : Actor Def Cfg Ctx FP Key}
    (hu : UChain (scK Key) μ τ (acc wff R) aStart cs e) :
    (∃ c' ∈ cs, c'.fam = c.fam ∧ c'.t = c.t ∧ c'.pat = c.pat ∧ c.r ≤ c'.r) ∨
    (e.st = .stranded ∧ ∀ c' ∈ cs, c'.t < c.t) := by
  subst hser
  have hc : App wff (scK Key) R aStart c := ⟨hvis, (scK_applies wff aStart c).mpr ⟨hfam, hD, hmatch, hst⟩⟩
  rcases complete_generic wff (scK Key) μ τ (acc_selOK wff R) hwf hu hc with
    ⟨a', c', hm, hs, hca, ht⟩ | h
  · have ⟨hc'a, hle⟩ := (acc_spec wff R a').1 c' hs
    have l := hle c hca
    have f1 := ((scK_applies wff a' c').mp hc'a.2).1
    have f2 := ((scK_applies wff a' c).mp hca.2).1
    have ht' : c'.t = c.t := ht
    have hp := hloc c' hc'a.1 c hvis (f1.trans f2.symm) ht'
    refine Or.inl ⟨c', hm, f1.trans f2.symm, ht', hp, ?_⟩
    unfold leS at l; rw [hp] at l; omega
  · exact Or.inr h

/-- Thm 5.2 packaged with termination: routing with budget `|R|` is complete. -/
theorem completeness_scalar_routeU {R : List (CP Fam Def FP)}
    (hwf : RegWF wff (scK Key) R) (hloc : OneLoc R)
    (a : Actor Def Cfg Ctx FP Key) (c : CP Fam Def FP) (hvis : c ∈ R)
    (hst : a.st ≠ .finished) (hfam : c.fam = wff a.d)
    (hmatch : c.pat.matches a.fp = true) (hD : a.ell ≤ c.t) :
    let res := routeU (scK Key) μ τ (acc wff R) R.length a
    (∃ c' ∈ res.1, c'.fam = c.fam ∧ c'.t = c.t ∧ c'.pat = c.pat ∧ c.r ≤ c'.r) ∨
    (res.2.st = .stranded ∧ ∀ c' ∈ res.1, c'.t < c.t) :=
  completeness_scalar wff μ τ hwf hloc a a rfl c hvis hst hfam hmatch hD
    (routeU_complete_R wff (scK Key) μ τ (acc_selOK wff R) hwf a)

/-- **Thm 8.1 (b):** a change-point that is not the highest refinement of its location is
    never chosen. -/
theorem acc_max_refinement {R : List (CP Fam Def FP)} {a : Actor Def Cfg Ctx FP Key}
    {c : CP Fam Def FP} (h : acc wff R a = some c) {c' : CP Fam Def FP} (hc' : c' ∈ R)
    (hf : c'.fam = c.fam) (ht : c'.t = c.t) (hp : c'.pat = c.pat) : c'.r ≤ c.r := by
  have ⟨hca, hle⟩ := (acc_spec wff R a).1 c h
  have ac := (scK_applies wff a c).mp hca.2
  have hc'a : App wff (scK Key) R a c' :=
    ⟨hc', (scK_applies wff a c').mpr ⟨hf ▸ ac.1, ht ▸ ac.2.1, hp ▸ ac.2.2.1, ac.2.2.2⟩⟩
  have l := hle c' hc'a
  unfold leS at l; rw [hp] at l; omega

/-- **Thm 8.1 (a), scalar:** pruning below the frontier does not change `Acc`. -/
theorem acc_prune (f : Fam) (Φ : Nat) (R : List (CP Fam Def FP)) (a : Actor Def Cfg Ctx FP Key)
    (hΦ : wff a.d = f → Φ ≤ a.ell) :
    acc wff (prune (scK Key) f Φ R) a = acc wff R a := by
  unfold acc; rw [prune_applicable wff (scK Key) f Φ R a hΦ]

end Scalar

/-! ## §4 Parallel change-points (Section 7) -/

/-- parallel change-point `(f, t, S, r, d')`; the selector `S` is a list of keys used as a
    set (matching is `S ⊆ K_a` by membership; implementations store it normalized). -/
structure PCP (Fam Def Key : Type) where
  fam : Fam
  t   : Nat
  sel : List Key
  r   : Nat
  tgt : Def

/-- `S ⊆ T` as sets, via `List.all` / membership -/
def sub {Key : Type} [DecidableEq Key] (S T : List Key) : Bool := S.all (fun k => decide (k ∈ T))

theorem sub_iff {Key : Type} [DecidableEq Key] (S T : List Key) :
    sub S T = true ↔ ∀ k ∈ S, k ∈ T := by
  simp [sub, List.all_eq_true]

section Parallel
variable {Fam Def Cfg Ctx FP Key : Type} [DecidableEq Fam] [DecidableEq Key]
variable (wff : Def → Fam)

def parK (FP : Type) : Kind Fam Def FP Key (PCP Fam Def Key) where
  fam := PCP.fam
  t := PCP.t
  tgt := PCP.tgt
  mt := fun p _ ks => sub p.sel ks

theorem parK_applies (a : Actor Def Cfg Ctx FP Key) (p : PCP Fam Def Key) :
    applies wff (parK FP) a p = true ↔
      p.fam = wff a.d ∧ a.ell ≤ p.t ∧ sub p.sel a.keys = true ∧ a.st ≠ .finished :=
  applies_iff wff (parK FP) a p

-- total tie-break: `comp(S)` and `id(d')` modelled as arbitrary `Nat`-valued functions
variable (comp : List Key → Nat) (tid : Def → Nat)

/-- Def 7.3: lexicographic order on `(t, -|S|, -r, comp(S), id(d'))` -/
def leP (p1 p2 : PCP Fam Def Key) : Prop :=
  p1.t < p2.t ∨ (p1.t = p2.t ∧ (p2.sel.length < p1.sel.length ∨ (p1.sel.length = p2.sel.length ∧
    (p2.r < p1.r ∨ (p1.r = p2.r ∧ (comp p1.sel < comp p2.sel ∨
      (comp p1.sel = comp p2.sel ∧ tid p1.tgt ≤ tid p2.tgt)))))))

instance (p1 p2 : PCP Fam Def Key) : Decidable (leP comp tid p1 p2) := by
  unfold leP; infer_instance

def lePb (p1 p2 : PCP Fam Def Key) : Bool := decide (leP comp tid p1 p2)

/-- **Thm 7.4, part 1:** the parallel order is total and transitive (a total preorder). -/
theorem leP_total (p1 p2 : PCP Fam Def Key) : leP comp tid p1 p2 ∨ leP comp tid p2 p1 := by
  unfold leP; omega
theorem leP_trans {p1 p2 p3 : PCP Fam Def Key} :
    leP comp tid p1 p2 → leP comp tid p2 p3 → leP comp tid p1 p3 := by
  unfold leP; omega

/-- parallel registry condition: no two with the same family, time, selector and index -/
def PRegUniq (R : List (PCP Fam Def Key)) : Prop :=
  ∀ p1 ∈ R, ∀ p2 ∈ R, p1.fam = p2.fam → p1.t = p2.t → p1.sel = p2.sel → p1.r = p2.r → p1 = p2

/-- proviso of Thm 7.4: `comp` does not collide on the selectors registered at one time -/
def NoCollision (R : List (PCP Fam Def Key)) : Prop :=
  ∀ p1 ∈ R, ∀ p2 ∈ R, p1.fam = p2.fam → p1.t = p2.t → comp p1.sel = comp p2.sel → p1.sel = p2.sel

/-- **Thm 7.4, part 2:** on a registry satisfying the registry condition and the
    no-collision proviso, the order is antisymmetric within a family -- hence a total
    order.  (The `id(d')` component is not needed.) -/
theorem leP_antisymm {R : List (PCP Fam Def Key)} (hu : PRegUniq R) (hn : NoCollision comp R)
    {p1 p2 : PCP Fam Def Key} (h1 : p1 ∈ R) (h2 : p2 ∈ R) (hf : p1.fam = p2.fam)
    (h12 : leP comp tid p1 p2) (h21 : leP comp tid p2 p1) : p1 = p2 := by
  have ht : p1.t = p2.t ∧ p1.r = p2.r ∧ comp p1.sel = comp p2.sel := by
    unfold leP at h12 h21; omega
  exact hu p1 h1 p2 h2 hf ht.1 (hn p1 h1 p2 h2 hf ht.1 ht.2.2) ht.2.1

/-- `Acc_∥(a)` (Def 7.3) -/
def accP (R : List (PCP Fam Def Key)) (a : Actor Def Cfg Ctx FP Key) : Option (PCP Fam Def Key) :=
  least (lePb comp tid) (R.filter (applies wff (parK FP) a))

def IsLeastP (R : List (PCP Fam Def Key)) (a : Actor Def Cfg Ctx FP Key) (p : PCP Fam Def Key) : Prop :=
  App wff (parK FP) R a p ∧ ∀ p', App wff (parK FP) R a p' → leP comp tid p p'

theorem accP_spec (R : List (PCP Fam Def Key)) (a : Actor Def Cfg Ctx FP Key) :
    (∀ p, accP wff comp tid R a = some p → IsLeastP wff comp tid R a p) ∧
    (accP wff comp tid R a = none → ∀ p, ¬ App wff (parK FP) R a p) := by
  have htot : ∀ x y : PCP Fam Def Key, lePb comp tid x y = true ∨ lePb comp tid y x = true := by
    intro x y; simp only [lePb, decide_eq_true_eq]; exact leP_total comp tid x y
  have htr : ∀ x y z : PCP Fam Def Key, lePb comp tid x y = true → lePb comp tid y z = true →
      lePb comp tid x z = true := by
    intro x y z; simp only [lePb, decide_eq_true_eq]; exact leP_trans comp tid
  constructor
  · intro p h
    have ⟨hm, hl⟩ := least_some (lePb comp tid) htot htr _ p h
    refine ⟨List.mem_filter.mp hm, fun p' hp' => ?_⟩
    have := hl p' (List.mem_filter.mpr hp')
    simpa [lePb] using this
  · intro h p hp
    have := least_none (lePb comp tid) _ h
    have hm : p ∈ R.filter (applies wff (parK FP) a) := List.mem_filter.mpr hp
    rw [this] at hm; cases hm

theorem accP_selOK (R : List (PCP Fam Def Key)) :
    SelOK wff (parK FP) R (accP (Cfg := Cfg) (Ctx := Ctx) wff comp tid R) := by
  intro a
  refine ⟨fun p h => ?_, (accP_spec wff comp tid R a).2⟩
  have ⟨h1, h2⟩ := (accP_spec wff comp tid R a).1 p h
  refine ⟨h1, fun p' hp' => ?_⟩
  have := h2 p' hp'
  show p.t ≤ p'.t
  unfold leP at this; omega

/-- **Thm 7.4 (Parallel determinism).** -/
theorem par_determinism {R : List (PCP Fam Def Key)} (hu : PRegUniq R) (hn : NoCollision comp R)
    {a : Actor Def Cfg Ctx FP Key} {p1 p2 : PCP Fam Def Key}
    (h1 : IsLeastP wff comp tid R a p1) (h2 : IsLeastP wff comp tid R a p2) : p1 = p2 := by
  have a1 := (parK_applies wff a p1).mp h1.1.2
  have a2 := (parK_applies wff a p2).mp h2.1.2
  exact leP_antisymm comp tid hu hn h1.1.1 h2.1.1 (a1.1.trans a2.1.symm) (h1.2 p2 h2.1) (h2.2 p1 h1.1)

/-- **Def 7.5 (Registration rule)** for adding `n` to registry `R`. -/
def Admits (R : List (PCP Fam Def Key)) (n : PCP Fam Def Key) : Prop :=
  ∀ c1 ∈ R, c1.fam = n.fam → c1.t = n.t → c1.sel ≠ n.sel → c1.sel.length = n.sel.length →
    c1.tgt ≠ n.tgt →
    ∃ c2 ∈ R, c2.fam = n.fam ∧ c2.t = n.t ∧ n.sel.length < c2.sel.length ∧
      sub c2.sel (c1.sel ++ n.sel) = true

/-- a registry built by successive admitted registrations (newest first) -/
inductive Built : List (PCP Fam Def Key) → Prop
  | nil : Built []
  | add (R : List (PCP Fam Def Key)) (n : PCP Fam Def Key) : Built R → Admits R n → Built (n :: R)

theorem built_witness {R : List (PCP Fam Def Key)} (hB : Built R) :
    ∀ c1 ∈ R, ∀ c2 ∈ R, c1.fam = c2.fam → c1.t = c2.t → c1.sel ≠ c2.sel →
      c1.sel.length = c2.sel.length → c1.tgt ≠ c2.tgt →
      ∃ c3 ∈ R, c3.fam = c1.fam ∧ c3.t = c1.t ∧ c1.sel.length < c3.sel.length ∧
        ∀ k ∈ c3.sel, k ∈ c1.sel ∨ k ∈ c2.sel := by
  induction hB with
  | nil => intro c1 h; cases h
  | add R n _ hA ih =>
    intro c1 h1 c2 h2 hf ht hs hl hd
    rcases List.mem_cons.mp h1 with e1 | m1 <;> rcases List.mem_cons.mp h2 with e2 | m2
    · exact absurd (e1.trans e2.symm ▸ rfl) hs
    · subst e1
      have ⟨c3, h3, f3, t3, l3, s3⟩ := hA c2 m2 hf.symm ht.symm (Ne.symm hs) hl.symm (Ne.symm hd)
      refine ⟨c3, List.mem_cons_of_mem _ h3, f3, t3, by omega, fun k hk => ?_⟩
      have := (sub_iff _ _).mp s3 k hk
      rcases List.mem_append.mp this with h | h
      · exact Or.inr h
      · exact Or.inl h
    · subst e2
      have ⟨c3, h3, f3, t3, l3, s3⟩ := hA c1 m1 hf ht hs hl hd
      refine ⟨c3, List.mem_cons_of_mem _ h3, f3.trans hf.symm, t3.trans ht.symm, by omega,
        fun k hk => List.mem_append.mp ((sub_iff _ _).mp s3 k hk)⟩
    · have ⟨c3, h3, rest⟩ := ih c1 m1 c2 m2 hf ht hs hl hd
      exact ⟨c3, List.mem_cons_of_mem _ h3, rest⟩

/-- **Prop 7.6 (No arbitrary outcomes).**  In a registry built under the registration
    rule, if the chosen `p` and another applicable `c` tie on time and selector size but
    have different targets, then they have the *same* selector and `c` loses by a strictly
    smaller refinement index -- never by `comp`, `id`, or the index of another selector. -/
theorem no_arbitrary {R : List (PCP Fam Def Key)} (hB : Built R) (hu : PRegUniq R)
    {a : Actor Def Cfg Ctx FP Key} {p c : PCP Fam Def Key}
    (hp : IsLeastP wff comp tid R a p) (hc : App wff (parK FP) R a c)
    (ht : c.t = p.t) (hl : c.sel.length = p.sel.length) (hd : c.tgt ≠ p.tgt) :
    c.sel = p.sel ∧ c.r < p.r := by
  have ap := (parK_applies wff a p).mp hp.1.2
  have ac := (parK_applies wff a c).mp hc.2
  have hf : c.fam = p.fam := ac.1.trans ap.1.symm
  by_cases hs : c.sel = p.sel
  · refine ⟨hs, ?_⟩
    have l := hp.2 c hc
    have hle : c.r ≤ p.r := by unfold leP at l; omega
    cases Nat.lt_or_eq_of_le hle with
    | inl h => exact h
    | inr h => exact absurd (congrArg PCP.tgt (hu c hc.1 p hp.1.1 hf ht hs h)) hd
  · exfalso
    have ⟨c3, h3, f3, t3, l3, s3⟩ := built_witness hB c hc.1 p hp.1.1 hf ht hs hl hd
    have sc := (sub_iff _ _).mp ac.2.2.1
    have sp := (sub_iff _ _).mp ap.2.2.1
    have hc3 : App wff (parK FP) R a c3 := by
      refine ⟨h3, (parK_applies wff a c3).mpr ⟨f3.trans ac.1, t3 ▸ ac.2.1, ?_, ac.2.2.2⟩⟩
      apply (sub_iff _ _).mpr
      intro k hk
      rcases s3 k hk with h | h
      · exact sc k h
      · exact sp k h
    have l := hp.2 c3 hc3
    unfold leP at l; omega

theorem accP_prune (f : Fam) (Φ : Nat) (R : List (PCP Fam Def Key)) (a : Actor Def Cfg Ctx FP Key)
    (hΦ : wff a.d = f → Φ ≤ a.ell) :
    accP wff comp tid (prune (parK FP) f Φ R) a = accP wff comp tid R a := by
  unfold accP; rw [prune_applicable wff (parK FP) f Φ R a hΦ]

end Parallel

/-! ## §5 Combined routing (Def 7.7, revised: the earlier of the two; ties -> scalar) -/

inductive AnyCP (Fam Def FP Key : Type)
  | sc (c : CP Fam Def FP)
  | par (p : PCP Fam Def Key)

section Combined
variable {Fam Def Cfg Ctx FP Key : Type} [DecidableEq Fam] [DecidableEq FP] [DecidableEq Key]
variable (wff : Def → Fam) (comp : List Key → Nat) (tid : Def → Nat)

def AnyCP.fam : AnyCP Fam Def FP Key → Fam
  | .sc c => c.fam
  | .par p => p.fam
def AnyCP.t : AnyCP Fam Def FP Key → Nat
  | .sc c => c.t
  | .par p => p.t
def AnyCP.tgt : AnyCP Fam Def FP Key → Def
  | .sc c => c.tgt
  | .par p => p.tgt

def anyK : Kind Fam Def FP Key (AnyCP Fam Def FP Key) where
  fam := AnyCP.fam
  t := AnyCP.t
  tgt := AnyCP.tgt
  mt := fun
    | .sc c, fp, _ => c.pat.matches fp
    | .par p, _, ks => sub p.sel ks

/-- the union of the scalar and the parallel registry -/
def union (R : List (CP Fam Def FP)) (Rp : List (PCP Fam Def Key)) : List (AnyCP Fam Def FP Key) :=
  R.map .sc ++ Rp.map .par

variable {R : List (CP Fam Def FP)} {Rp : List (PCP Fam Def Key)}

theorem app_any_sc (a : Actor Def Cfg Ctx FP Key) (c : CP Fam Def FP) :
    App wff anyK (union R Rp) a (.sc c) ↔ App wff (scK Key) R a c := by
  have hm : AnyCP.sc c ∈ union R Rp ↔ c ∈ R := by
    simp only [union, List.mem_append, List.mem_map]
    constructor
    · rintro (⟨c', h, e⟩ | ⟨p', _, e⟩)
      · cases e; exact h
      · cases e
    · intro h; exact Or.inl ⟨c, h, rfl⟩
  unfold App
  rw [hm]; exact Iff.rfl

theorem app_any_par (a : Actor Def Cfg Ctx FP Key) (p : PCP Fam Def Key) :
    App wff anyK (union R Rp) a (.par p) ↔ App wff (parK FP) Rp a p := by
  have hm : AnyCP.par p ∈ union R Rp ↔ p ∈ Rp := by
    simp only [union, List.mem_append, List.mem_map]
    constructor
    · rintro (⟨c', _, e⟩ | ⟨p', h, e⟩)
      · cases e
      · cases e; exact h
    · intro h; exact Or.inr ⟨p, h, rfl⟩
  unfold App
  rw [hm]; exact Iff.rfl

variable (R Rp)

/-- **Def 7.7 (revised).** `Acc⁺(a)` is the earlier of `Acc(a)` and `Acc_∥(a)`;
    at equal times the scalar one. -/
def accPlus (a : Actor Def Cfg Ctx FP Key) : Option (AnyCP Fam Def FP Key) :=
  match acc wff R a, accP wff comp tid Rp a with
  | none, none => none
  | some c, none => some (.sc c)
  | none, some p => some (.par p)
  | some c, some p => if c.t ≤ p.t then some (.sc c) else some (.par p)

variable {R Rp}

theorem accPlus_some {a : Actor Def Cfg Ctx FP Key} {x : AnyCP Fam Def FP Key}
    (h : accPlus wff comp tid R Rp a = some x) :
    (∃ c, x = .sc c ∧ acc wff R a = some c ∧ ∀ p, accP wff comp tid Rp a = some p → c.t ≤ p.t) ∨
    (∃ p, x = .par p ∧ accP wff comp tid Rp a = some p ∧ ∀ c, acc wff R a = some c → p.t < c.t) := by
  unfold accPlus at h
  cases h1 : acc wff R a with
  | none =>
    cases h2 : accP wff comp tid Rp a with
    | none => rw [h1, h2] at h; cases h
    | some p =>
      rw [h1, h2] at h; cases h
      exact Or.inr ⟨p, rfl, rfl, fun c hc => by cases hc⟩
  | some c =>
    cases h2 : accP wff comp tid Rp a with
    | none =>
      rw [h1, h2] at h; cases h
      exact Or.inl ⟨c, rfl, rfl, fun p hp => by cases hp⟩
    | some p =>
      rw [h1, h2] at h; dsimp only at h
      split at h
      · rename_i hle; cases h
        exact Or.inl ⟨c, rfl, rfl, fun p' hp' => by cases hp'; exact hle⟩
      · rename_i hlt; cases h
        exact Or.inr ⟨p, rfl, rfl, fun c' hc' => by cases hc'; omega⟩

theorem accPlus_none {a : Actor Def Cfg Ctx FP Key} :
    accPlus wff comp tid R Rp a = none ↔ acc wff R a = none ∧ accP wff comp tid Rp a = none := by
  unfold accPlus
  cases acc wff R a <;> cases accP wff comp tid Rp a <;> simp
  split <;> simp

/-- ties go to the scalar change-point -/
theorem accPlus_tie {a : Actor Def Cfg Ctx FP Key} {c p}
    (h1 : acc wff R a = some c) (h2 : accP wff comp tid Rp a = some p) (ht : c.t = p.t) :
    accPlus wff comp tid R Rp a = some (.sc c) := by
  unfold accPlus; rw [h1, h2]; dsimp only; rw [if_pos (by omega)]

/-- **Acc⁺ is never later than either component.** -/
theorem accPlus_le {a : Actor Def Cfg Ctx FP Key} {x : AnyCP Fam Def FP Key}
    (h : accPlus wff comp tid R Rp a = some x) :
    (∀ c, acc wff R a = some c → x.t ≤ c.t) ∧ (∀ p, accP wff comp tid Rp a = some p → x.t ≤ p.t) := by
  rcases accPlus_some wff comp tid h with ⟨c, rfl, hc, hp⟩ | ⟨p, rfl, hp, hc⟩
  · refine ⟨fun c' hc' => ?_, fun p' hp' => hp p' hp'⟩
    rw [hc] at hc'; cases hc'; exact Nat.le_refl _
  · refine ⟨fun c' hc' => Nat.le_of_lt (hc c' hc'), fun p' hp' => ?_⟩
    rw [hp] at hp'; cases hp'; exact Nat.le_refl _

/-- **Acc⁺ is the minimum-time applicable change-point over the union**
    (and `none` only if nothing in the union applies). -/
theorem accPlus_selOK :
    SelOK wff anyK (union R Rp) (accPlus (Cfg := Cfg) (Ctx := Ctx) wff comp tid R Rp) := by
  intro a
  have sS := acc_spec (Cfg := Cfg) (Ctx := Ctx) wff R a
  have sP := accP_spec (Cfg := Cfg) (Ctx := Ctx) wff comp tid Rp a
  -- every applicable scalar/parallel change-point is no earlier than acc / accP
  have minS : ∀ c', App wff (scK Key) R a c' → ∃ c, acc wff R a = some c ∧ c.t ≤ c'.t := by
    intro c' hc'
    cases h : acc wff R a with
    | none => exact absurd hc' (sS.2 h c')
    | some c => have := (sS.1 c h).2 c' hc'; exact ⟨c, rfl, by unfold leS at this; omega⟩
  have minP : ∀ p', App wff (parK FP) Rp a p' → ∃ p, accP wff comp tid Rp a = some p ∧ p.t ≤ p'.t := by
    intro p' hp'
    cases h : accP wff comp tid Rp a with
    | none => exact absurd hp' (sP.2 h p')
    | some p => have := (sP.1 p h).2 p' hp'; exact ⟨p, rfl, by unfold leP at this; omega⟩
  constructor
  · intro x hx
    rcases accPlus_some wff comp tid hx with ⟨c, rfl, hc, hcp⟩ | ⟨p, rfl, hp, hpc⟩
    · refine ⟨(app_any_sc wff a c).mpr (sS.1 c hc).1, fun y hy => ?_⟩
      cases y with
      | sc c' =>
        have ⟨c0, h0, hle⟩ := minS c' ((app_any_sc wff a c').mp hy)
        rw [hc] at h0; cases h0; exact hle
      | par p' =>
        have ⟨p0, h0, hle⟩ := minP p' ((app_any_par wff a p').mp hy)
        have := hcp p0 h0
        show c.t ≤ p'.t; omega
    · refine ⟨(app_any_par wff a p).mpr (sP.1 p hp).1, fun y hy => ?_⟩
      cases y with
      | sc c' =>
        have ⟨c0, h0, hle⟩ := minS c' ((app_any_sc wff a c').mp hy)
        have := hpc c0 h0
        show p.t ≤ c'.t; omega
      | par p' =>
        have ⟨p0, h0, hle⟩ := minP p' ((app_any_par wff a p').mp hy)
        rw [hp] at h0; cases h0; exact hle
  · intro hn y hy
    have ⟨h1, h2⟩ := (accPlus_none wff comp tid).mp hn
    cases y with
    | sc c' => exact sS.2 h1 c' ((app_any_sc wff a c').mp hy)
    | par p' => exact sP.2 h2 p' ((app_any_par wff a p').mp hy)

/-- the combined registry is well formed iff both parts are -/
theorem regWF_union (h1 : RegWF wff (scK Key) R) (h2 : RegWF wff (parK FP) Rp) :
    RegWF wff anyK (union R Rp) := by
  intro x hx
  simp only [union, List.mem_append, List.mem_map] at hx
  rcases hx with ⟨c, hc, rfl⟩ | ⟨p, hp, rfl⟩
  · exact h1 c hc
  · exact h2 p hp

variable (μ : Def → Cfg → Option Cfg) (τ : Def → Ctx → Option Ctx)

/-- **Thm 5.2 for scalar change-points under combined routing.**  Hypotheses as in
    `completeness_scalar`.  The tie rule (scalar wins at equal time) means a parallel
    change-point can never shadow `c`. -/
theorem completeness_plus_scalar
    (hwf1 : RegWF wff (scK Key) R) (hwf2 : RegWF wff (parK FP) Rp) (hloc : OneLoc R)
    (aCommit aStart : Actor Def Cfg Ctx FP Key) (hser : aStart = aCommit)
    (c : CP Fam Def FP) (hvis : c ∈ R)
    (hst : aCommit.st ≠ .finished) (hfam : c.fam = wff aCommit.d)
    (hmatch : c.pat.matches aCommit.fp = true) (hD : aCommit.ell ≤ c.t)
    {cs : List (AnyCP Fam Def FP Key)} {e : Actor Def Cfg Ctx FP Key}
    (hu : UChain anyK μ τ (accPlus wff comp tid R Rp) aStart cs e) :
    (∃ c', AnyCP.sc c' ∈ cs ∧ c'.fam = c.fam ∧ c'.t = c.t ∧ c'.pat = c.pat ∧ c.r ≤ c'.r) ∨
    (e.st = .stranded ∧ ∀ x ∈ cs, x.t < c.t) := by
  subst hser
  have hcS : App wff (scK Key) R aStart c :=
    ⟨hvis, (scK_applies wff aStart c).mpr ⟨hfam, hD, hmatch, hst⟩⟩
  have hc := (app_any_sc (Rp := Rp) wff aStart c).mpr hcS
  rcases complete_generic wff anyK μ τ (accPlus_selOK wff comp tid) (regWF_union wff hwf1 hwf2)
      hu hc with ⟨a', x, hm, hs, hca, ht⟩ | h
  · have hcaS := (app_any_sc wff a' c).mp hca
    rcases accPlus_some wff comp tid hs with ⟨c', rfl, hc', _⟩ | ⟨p, rfl, _, hpc⟩
    · have ⟨hc'a, hle⟩ := (acc_spec wff R a').1 c' hc'
      have l := hle c hcaS
      have f1 := ((scK_applies wff a' c').mp hc'a.2).1
      have f2 := ((scK_applies wff a' c).mp hcaS.2).1
      have ht' : c'.t = c.t := ht
      have hp := hloc c' hc'a.1 c hvis (f1.trans f2.symm) ht'
      refine Or.inl ⟨c', hm, f1.trans f2.symm, ht', hp, ?_⟩
      unfold leS at l; rw [hp] at l; omega
    · exfalso
      cases h0 : acc wff R a' with
      | none => exact (acc_spec wff R a').2 h0 c hcaS
      | some c0 =>
        have l := ((acc_spec wff R a').1 c0 h0).2 c hcaS
        have := hpc c0 h0
        have ht' : p.t = c.t := ht
        unfold leS at l; omega
  · exact Or.inr h

/-- **Thm 5.2 for parallel change-points under combined routing (general form).**
    For `c` parallel with `S_c ⊆ K_a`, the actor is routed through a change-point of
    family `f_c` at exactly time `t_c`: either a scalar one, or a parallel one that was
    least in a state where `c` was still applicable (hence its selector is at least as
    large as `S_c`); or it is stranded at a strictly earlier hop. -/
theorem completeness_plus_par
    (hwf1 : RegWF wff (scK Key) R) (hwf2 : RegWF wff (parK FP) Rp)
    (aCommit aStart : Actor Def Cfg Ctx FP Key) (hser : aStart = aCommit)
    (c : PCP Fam Def Key) (hvis : c ∈ Rp)
    (hst : aCommit.st ≠ .finished) (hfam : c.fam = wff aCommit.d)
    (hmatch : sub c.sel aCommit.keys = true) (hD : aCommit.ell ≤ c.t)
    {cs : List (AnyCP Fam Def FP Key)} {e : Actor Def Cfg Ctx FP Key}
    (hu : UChain anyK μ τ (accPlus wff comp tid R Rp) aStart cs e) :
    (∃ c', AnyCP.sc c' ∈ cs ∧ c' ∈ R ∧ c'.fam = c.fam ∧ c'.t = c.t) ∨
    (∃ (a' : Actor Def Cfg Ctx FP Key) (p : PCP Fam Def Key), AnyCP.par p ∈ cs ∧ IsLeastP wff comp tid Rp a' p ∧ App wff (parK FP) Rp a' c ∧
        p.fam = c.fam ∧ p.t = c.t ∧ c.sel.length ≤ p.sel.length) ∨
    (e.st = .stranded ∧ ∀ x ∈ cs, x.t < c.t) := by
  subst hser
  have hcP : App wff (parK FP) Rp aStart c :=
    ⟨hvis, (parK_applies wff aStart c).mpr ⟨hfam, hD, hmatch, hst⟩⟩
  have hc := (app_any_par (R := R) wff aStart c).mpr hcP
  rcases complete_generic wff anyK μ τ (accPlus_selOK wff comp tid) (regWF_union wff hwf1 hwf2)
      hu hc with ⟨a', x, hm, hs, hca, ht⟩ | h
  · have hcaP := (app_any_par wff a' c).mp hca
    have fc := ((parK_applies wff a' c).mp hcaP.2).1
    rcases accPlus_some wff comp tid hs with ⟨c', rfl, hc', _⟩ | ⟨p, rfl, hp, _⟩
    · have hc'a := ((acc_spec wff R a').1 c' hc').1
      have f1 := ((scK_applies wff a' c').mp hc'a.2).1
      exact Or.inl ⟨c', hm, hc'a.1, f1.trans fc.symm, ht⟩
    · have hl := (accP_spec wff comp tid Rp a').1 p hp
      have f1 := ((parK_applies wff a' p).mp hl.1.2).1
      have l := hl.2 c hcaP
      have ht' : p.t = c.t := ht
      refine Or.inr (Or.inl ⟨a', p, hm, hl, hcaP, f1.trans fc.symm, ht', ?_⟩)
      unfold leP at l; omega
  · exact Or.inr (Or.inr h)

/-- no (family, time) carries both a scalar and a parallel change-point
    (true when each deployment is either scalar or parallel and times are fresh) -/
def NoMix (R : List (CP Fam Def FP)) (Rp : List (PCP Fam Def Key)) : Prop :=
  ∀ c ∈ R, ∀ p ∈ Rp, c.fam = p.fam → c.t ≠ p.t

/-- **Thm 5.2 for parallel change-points (clean form).**  With `NoMix` the actor passes
    through a *parallel* change-point at `(f_c, t_c)` whose selector is at least as large
    as `S_c`, or is stranded earlier.  If moreover the parallel registry was built under
    the registration rule, a same-size selector with a different target is `S_c` itself. -/
theorem completeness_plus_par_clean
    (hwf1 : RegWF wff (scK Key) R) (hwf2 : RegWF wff (parK FP) Rp) (hmix : NoMix R Rp)
    (aCommit aStart : Actor Def Cfg Ctx FP Key) (hser : aStart = aCommit)
    (c : PCP Fam Def Key) (hvis : c ∈ Rp)
    (hst : aCommit.st ≠ .finished) (hfam : c.fam = wff aCommit.d)
    (hmatch : sub c.sel aCommit.keys = true) (hD : aCommit.ell ≤ c.t)
    {cs : List (AnyCP Fam Def FP Key)} {e : Actor Def Cfg Ctx FP Key}
    (hu : UChain anyK μ τ (accPlus wff comp tid R Rp) aStart cs e) :
    (∃ p, AnyCP.par p ∈ cs ∧ p ∈ Rp ∧ p.fam = c.fam ∧ p.t = c.t ∧ c.sel.length ≤ p.sel.length ∧
        ((Built Rp ∧ PRegUniq Rp) → c.sel.length = p.sel.length → c.tgt ≠ p.tgt →
          c.sel = p.sel ∧ c.r < p.r)) ∨
    (e.st = .stranded ∧ ∀ x ∈ cs, x.t < c.t) := by
  rcases completeness_plus_par wff comp tid μ τ hwf1 hwf2 aCommit aStart hser c hvis hst hfam
      hmatch hD hu with ⟨c', _, hc'R, hf, ht⟩ | ⟨a', p, hm, hl, hca, hf, ht, hsz⟩ | h
  · exact absurd ht (hmix c' hc'R c hvis hf)
  · refine Or.inl ⟨p, hm, hl.1.1, hf, ht, hsz, fun ⟨hB, hU⟩ hlen hd =>
      no_arbitrary wff comp tid hB hU hl hca ht.symm hlen hd⟩
  · exact Or.inr h

/-- Thm 4.2 for combined routing: every hop chosen by `Acc⁺` advances logical time,
    chains use pairwise distinct change-points, and routing with budget `|R| + |Rp|`
    is complete (terminates at a fixpoint or a stranding). -/
theorem progress_plus (hwf1 : RegWF wff (scK Key) R) (hwf2 : RegWF wff (parK FP) Rp)
    (a : Actor Def Cfg Ctx FP Key) :
    UChain anyK μ τ (accPlus wff comp tid R Rp) a
      (routeU anyK μ τ (accPlus wff comp tid R Rp) (union R Rp).length a).1
      (routeU anyK μ τ (accPlus wff comp tid R Rp) (union R Rp).length a).2 :=
  routeU_complete_R wff anyK μ τ (accPlus_selOK wff comp tid) (regWF_union wff hwf1 hwf2) a

/-- **Thm 8.1 (a), combined:** pruning both registries below the frontier leaves
    `Acc⁺` unchanged for every actor of family `f` with `Φ ≤ ℓ_a` (and for every actor of
    any other family). -/
theorem accPlus_prune (f : Fam) (Φ : Nat) (a : Actor Def Cfg Ctx FP Key)
    (hΦ : wff a.d = f → Φ ≤ a.ell) :
    accPlus wff comp tid (prune (scK Key) f Φ R) (prune (parK FP) f Φ Rp) a =
      accPlus wff comp tid R Rp a := by
  unfold accPlus
  rw [acc_prune wff f Φ R a hΦ, accP_prune wff comp tid f Φ Rp a hΦ]

end Combined

/-! ## §6 Collection frontier over runs (Thm 8.1) -/

section Frontier
variable {Fam Def Cfg Ctx FP Key X Ev : Type} [DecidableEq Fam]
variable (K : Kind Fam Def FP Key X) (μ : Def → Cfg → Option Cfg) (τ : Def → Ctx → Option Ctx)
  (δ : Def → Cfg → Ev → Ctx → Option (Cfg × Ctx)) (final : Def → Cfg → Bool)
  (hfp : FP → Ev → FP) (upk : Def → Cfg → List Key → Ev → List Key)

/-- The frontier hypothesis is stable: once `Φ ≤ ℓ_a`, it stays true for the rest of the
    actor's life (logical time never decreases), so the pruned registry routes it exactly
    like the full one forever (`acc_prune`, `accP_prune`, `accPlus_prune`). -/
theorem frontier_persists {a cs e} (h : Run K μ τ δ final hfp upk a cs e) (Φ : Nat)
    (hΦ : Φ ≤ a.ell) : Φ ≤ e.ell :=
  Nat.le_trans hΦ (run_progress K μ τ δ final hfp upk h).1

end Frontier

/-! ## Axiom audit (expected: only `propext`, `Classical.choice`, `Quot.sound` or none) -/
#print axioms determinism
#print axioms acc_eq_iff
#print axioms chain_progress
#print axioms chain_nodup
#print axioms chain_length_le_R
#print axioms chain_length_le_times
#print axioms routeU_complete_R
#print axioms run_progress
#print axioms run_nodup
#print axioms run_invI
#print axioms completeness_scalar
#print axioms completeness_scalar_routeU
#print axioms run_safe
#print axioms spawn_safe
#print axioms leP_total
#print axioms leP_trans
#print axioms leP_antisymm
#print axioms par_determinism
#print axioms no_arbitrary
#print axioms accPlus_le
#print axioms accPlus_tie
#print axioms accPlus_none
#print axioms accPlus_selOK
#print axioms completeness_plus_scalar
#print axioms completeness_plus_par
#print axioms completeness_plus_par_clean
#print axioms progress_plus
#print axioms acc_prune
#print axioms accP_prune
#print axioms accPlus_prune
#print axioms acc_max_refinement
#print axioms frontier_persists

end APV
