/-
  Executable oracle: the machine-checked routing rule `accPlus` (APV.lean, Def 7.7),
  instantiated with natural numbers, answering routing questions read from stdin.
  Run with `oracle.sh` (it checks APV.lean together with this file).

  One question per line:   SCALARS | PARALLELS | ACTOR | FAMILIES
    SCALARS    ;-separated  "fam t e|w fp r target"       (e = exact pattern fp, w = wildcard)
    PARALLELS  ;-separated  "fam t k1,k2,... r target"
    ACTOR      "def fp k1,k2,... ell"         (no regional keys: "_")
    FAMILIES   ;-separated  "def fam"
  Answer per line: the routing chain `routeU` (Def 3.6, with total state mappings, at most
  64 hops) under the selection rule `accPlus`: "none" if the actor stays, otherwise its hops
  "s target t" / "p target t" separated by spaces.
-/
open APV

def natOf (s : String) : Nat := s.trim.toNat!
def wordsOf (s : String) : List String := (s.splitOn " ").filter (fun w => w ≠ "")
def listOf (s : String) : List Nat := ((s.trim.splitOn ",").filter (fun w => w ≠ "" && w ≠ "_")).map natOf
def itemsOf (s : String) : List String := (s.splitOn ";").filter (fun w => w.trim ≠ "")

def famTable (s : String) : List (Nat × Nat) :=
  (itemsOf s).filterMap fun it => match wordsOf it with
    | [d, f] => some (natOf d, natOf f)
    | _ => none

def famOf (tbl : List (Nat × Nat)) (d : Nat) : Nat :=
  match tbl.find? (fun p => p.1 == d) with
  | some p => p.2
  | none => 0

def scalarOf (s : String) : Option (CP Nat Nat Nat) :=
  match wordsOf s with
  | [f, t, k, h, r, tgt] =>
    some { fam := natOf f, t := natOf t, pat := (if k == "w" then Pat.wild else Pat.exact (natOf h)),
           r := natOf r, tgt := natOf tgt }
  | _ => none

def parOf (s : String) : Option (PCP Nat Nat Nat) :=
  match wordsOf s with
  | [f, t, ks, r, tgt] => some { fam := natOf f, t := natOf t, sel := listOf ks, r := natOf r, tgt := natOf tgt }
  | _ => none

def answer (line : String) : String :=
  match line.splitOn "|" with
  | [sc, pc, ac, fc] =>
    let R  := (itemsOf sc).filterMap scalarOf
    let Rp := (itemsOf pc).filterMap parOf
    let tbl := famTable fc
    match wordsOf ac with
    | [d, fp, ks, ell] =>
      let a : Actor Nat Unit Unit Nat Nat :=
        { d := natOf d, q := (), x := (), fp := natOf fp, keys := listOf ks, ell := natOf ell, st := .active }
      let sel := accPlus (famOf tbl) (fun l => l.foldl (· + ·) 0) id R Rp
      let hops := (routeU (anyK (Fam := Nat) (Def := Nat) (FP := Nat) (Key := Nat))
        (fun _ q => some q) (fun _ x => some x) sel 64 a).1
      if hops.isEmpty then "none" else
        " ".intercalate (hops.map fun
          | .sc c => s!"s {c.tgt} {c.t}"
          | .par p => s!"p {p.tgt} {p.t}")
    | _ => "error"
  | _ => "error"

partial def loop (stdin : IO.FS.Stream) : IO Unit := do
  let line ← stdin.getLine
  if line.isEmpty then return
  IO.println (answer line.trimRight)
  loop stdin

def main : IO Unit := do
  loop (← IO.getStdin)
