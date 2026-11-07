package d1

// Byte-level BPE matching Hugging Face tokenizers / Transformers.js for the
// d1 (LFM2.5) and Compass VLD v6 (LFM3) tokenizer.json files: added-token
// splitting, the Llama-3 style split regex, GPT-2 byte mapping, rank-ordered
// merges and ignore_merges (a word already in the vocabulary is one token).

import (
	"container/heap"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"

	"github.com/dlclark/regexp2"
)

type addedToken struct {
	ID      int    `json:"id"`
	Content string `json:"content"`
	Special bool   `json:"special"`
}

type Tokenizer struct {
	vocab      map[string]int
	ranks      map[string]int
	added      []addedToken // longest first
	addedOrder []addedToken // tokenizer.json order
	addedBy    map[string]int
	split      *regexp2.Regexp
	byteEnc    [256]string
	// ignoreMerges emits a pre-tokenized word that is itself in the
	// vocabulary as that token, before any merge (BPE ignore_merges).
	ignoreMerges bool
	cacheMu      sync.Mutex
	cache        map[string][]int
	BosID        int
	PadID        int
}

// JavaScript's \s (what Transformers.js' RegExp uses), spelled out so the
// .NET-flavoured engine matches the browser exactly.
var jsSpace = jsSpaceClass()

// jsSpaceClass spells JavaScript's \s as regexp escapes (built at run time so
// the source stays ASCII).
func jsSpaceClass() string {
	var b strings.Builder
	b.WriteString(`\t\n\v\f\r `)
	esc := func(cp int) { fmt.Fprintf(&b, "\\%s%04x", "u", cp) }
	for _, cp := range []int{0x00a0, 0x1680} {
		esc(cp)
	}
	esc(0x2000)
	b.WriteByte('-')
	esc(0x200a)
	for _, cp := range []int{0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff} {
		esc(cp)
	}
	return b.String()
}

func bytesToUnicode() [256]string {
	var bs []int
	for b := '!'; b <= '~'; b++ {
		bs = append(bs, int(b))
	}
	for b := 0xA1; b <= 0xAC; b++ {
		bs = append(bs, b)
	}
	for b := 0xAE; b <= 0xFF; b++ {
		bs = append(bs, b)
	}
	cs := append([]int(nil), bs...)
	n := 0
	in := map[int]bool{}
	for _, b := range bs {
		in[b] = true
	}
	for b := 0; b < 256; b++ {
		if !in[b] {
			bs = append(bs, b)
			cs = append(cs, 256+n)
			n++
		}
	}
	var out [256]string
	for i, b := range bs {
		out[b] = string(rune(cs[i]))
	}
	return out
}

// LoadTokenizer reads a tokenizer.json of the d1 family.
func LoadTokenizer(path string) (*Tokenizer, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var raw struct {
		AddedTokens []addedToken `json:"added_tokens"`
		PreTok      struct {
			Type          string `json:"type"`
			Pretokenizers []struct {
				Type    string `json:"type"`
				Pattern struct {
					Regex string `json:"Regex"`
				} `json:"pattern"`
			} `json:"pretokenizers"`
		} `json:"pre_tokenizer"`
		Model struct {
			Type         string            `json:"type"`
			Vocab        map[string]int    `json:"vocab"`
			Merges       []json.RawMessage `json:"merges"`
			IgnoreMerges bool              `json:"ignore_merges"`
			ByteFallback bool              `json:"byte_fallback"`
		} `json:"model"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("tokenizer.json: %w", err)
	}
	if raw.Model.Type != "BPE" || raw.Model.ByteFallback {
		return nil, fmt.Errorf("unsupported tokenizer model %q", raw.Model.Type)
	}
	t := &Tokenizer{vocab: raw.Model.Vocab, ranks: make(map[string]int, len(raw.Model.Merges)),
		addedBy: map[string]int{}, cache: map[string][]int{}, byteEnc: bytesToUnicode(), ignoreMerges: raw.Model.IgnoreMerges}
	for i, m := range raw.Model.Merges {
		var pair []string
		if err := json.Unmarshal(m, &pair); err != nil {
			var s string
			if err := json.Unmarshal(m, &s); err != nil {
				return nil, errors.New("bad merge entry")
			}
			pair = strings.SplitN(s, " ", 2)
		}
		if len(pair) != 2 {
			return nil, errors.New("bad merge entry")
		}
		key := pair[0] + "\x00" + pair[1]
		if _, ok := t.ranks[key]; !ok {
			t.ranks[key] = i
		}
	}
	for _, a := range raw.AddedTokens {
		t.added = append(t.added, a)
		t.addedBy[a.Content] = a.ID
	}
	t.addedOrder = append([]addedToken(nil), t.added...)
	sort.SliceStable(t.added, func(i, j int) bool { return len(t.added[i].Content) > len(t.added[j].Content) })
	pattern := `(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\p{L}\p{N}` + jsSpace + `]+[\r\n]*|[` + jsSpace + `]*[\r\n]+|[` + jsSpace + `]+(?![^` + jsSpace + `])|[` + jsSpace + `]+`
	// The pattern above is this one with JavaScript's \s spelled out.
	const split = `(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+`
	for _, p := range raw.PreTok.Pretokenizers {
		if p.Type == "Split" && p.Pattern.Regex != split {
			return nil, errors.New("unexpected pre-tokenizer pattern")
		}
	}
	t.split, err = regexp2.Compile(pattern, regexp2.Unicode)
	if err != nil {
		return nil, err
	}
	// No match timeout. regexp2 only turns timeouts off for this value; 0 is a
	// deadline of now, so matches failed whenever its coarse clock ticked
	// (more often under load) and the rest of the text became one BPE word.
	// Timeouts are the only errors FindRunesMatch/FindNextMatch return.
	t.split.MatchTimeout = regexp2.DefaultMatchTimeout
	t.BosID = t.ID("<|startoftext|>")
	t.PadID = t.ID("<|pad|>")
	return t, nil
}

// AddedTokens lists the contents of every added token, special or not, in
// tokenizer.json order (Transformers.js splits text on all of them).
func (t *Tokenizer) AddedTokens() []string {
	out := make([]string, 0, len(t.added))
	seen := map[int]bool{}
	for _, a := range t.addedOrder {
		if !seen[a.ID] {
			seen[a.ID] = true
			out = append(out, a.Content)
		}
	}
	return out
}

// ID returns a token's id (added tokens first), or -1.
func (t *Tokenizer) ID(token string) int {
	if id, ok := t.addedBy[token]; ok {
		return id
	}
	if id, ok := t.vocab[token]; ok {
		return id
	}
	return -1
}

// Encode tokenizes text without adding special tokens.
func (t *Tokenizer) Encode(text string) []int {
	var out []int
	for len(text) > 0 {
		pos, tok := t.nextAdded(text)
		if pos < 0 {
			out = append(out, t.encodePlain(text)...)
			break
		}
		if pos > 0 {
			out = append(out, t.encodePlain(text[:pos])...)
		}
		out = append(out, tok.ID)
		text = text[pos+len(tok.Content):]
	}
	return out
}

// nextAdded finds the leftmost added token (longest at that position).
func (t *Tokenizer) nextAdded(text string) (int, addedToken) {
	best := -1
	var bestTok addedToken
	for _, a := range t.added {
		i := strings.Index(text, a.Content)
		if i < 0 {
			continue
		}
		if best < 0 || i < best || (i == best && len(a.Content) > len(bestTok.Content)) {
			best, bestTok = i, a
		}
	}
	return best, bestTok
}

func (t *Tokenizer) encodePlain(text string) []int {
	runes := []rune(text)
	var out []int
	last := 0
	m, _ := t.split.FindRunesMatch(runes)
	for m != nil {
		if m.Index > last {
			out = append(out, t.bpeWord(string(runes[last:m.Index]))...)
		}
		out = append(out, t.bpeWord(string(runes[m.Index:m.Index+m.Length]))...)
		last = m.Index + m.Length
		m, _ = t.split.FindNextMatch(m)
	}
	if last < len(runes) {
		out = append(out, t.bpeWord(string(runes[last:]))...)
	}
	return out
}

type mergeCand struct {
	rank, pos int
	left      string
	right     string
}

type mergeHeap []mergeCand

func (h mergeHeap) Len() int { return len(h) }
func (h mergeHeap) Less(i, j int) bool {
	if h[i].rank != h[j].rank {
		return h[i].rank < h[j].rank
	}
	return h[i].pos < h[j].pos
}
func (h mergeHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *mergeHeap) Push(x any)   { *h = append(*h, x.(mergeCand)) }
func (h *mergeHeap) Pop() any {
	old := *h
	x := old[len(old)-1]
	*h = old[:len(old)-1]
	return x
}

func (t *Tokenizer) bpeWord(piece string) []int {
	if piece == "" {
		return nil
	}
	t.cacheMu.Lock()
	if ids, ok := t.cache[piece]; ok {
		t.cacheMu.Unlock()
		return ids
	}
	t.cacheMu.Unlock()

	syms := make([]string, 0, len(piece))
	for i := 0; i < len(piece); i++ {
		syms = append(syms, t.byteEnc[piece[i]])
	}
	if t.ignoreMerges {
		if id, ok := t.vocab[strings.Join(syms, "")]; ok {
			return []int{id}
		}
	}
	// Linked list over symbol slots.
	n := len(syms)
	prev := make([]int, n)
	next := make([]int, n)
	alive := make([]bool, n)
	for i := range syms {
		prev[i], next[i], alive[i] = i-1, i+1, true
	}
	next[n-1] = -1
	h := &mergeHeap{}
	push := func(i int) {
		if i < 0 || !alive[i] || next[i] < 0 {
			return
		}
		j := next[i]
		if r, ok := t.ranks[syms[i]+"\x00"+syms[j]]; ok {
			heap.Push(h, mergeCand{rank: r, pos: i, left: syms[i], right: syms[j]})
		}
	}
	for i := 0; i < n-1; i++ {
		push(i)
	}
	for h.Len() > 0 {
		c := heap.Pop(h).(mergeCand)
		i := c.pos
		if !alive[i] || next[i] < 0 || syms[i] != c.left || syms[next[i]] != c.right {
			continue
		}
		j := next[i]
		syms[i] = c.left + c.right
		alive[j] = false
		next[i] = next[j]
		if next[j] >= 0 {
			prev[next[j]] = i
		}
		push(prev[i])
		push(i)
	}
	var ids []int
	for i := 0; i >= 0; i = next[i] {
		if !alive[i] {
			continue
		}
		if id, ok := t.vocab[syms[i]]; ok {
			ids = append(ids, id)
		}
	}
	if len(piece) < 256 {
		t.cacheMu.Lock()
		if len(t.cache) > 50000 {
			t.cache = map[string][]int{}
		}
		t.cache[piece] = ids
		t.cacheMu.Unlock()
	}
	return ids
}
