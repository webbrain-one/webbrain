package d1

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"math"
	"testing"
)

// Golden values come from the extension's own functions
// (compass-vld-v6-runtime.js, compass-vld-runtime.js, webgpu-decisions.js)
// run under Node on the same inputs.

func TestCompassSmartResize(t *testing.T) {
	cases := [][4]int{{800, 1280, 800, 1280}, {768, 1366, 768, 1376}, {600, 800, 608, 800}, {200, 300, 224, 320},
		{1280, 720, 1280, 704}, {10, 2000, 32, 3648}, {4000, 6000, 3328, 4992}, {33, 47, 224, 320}}
	for _, c := range cases {
		h, w, err := smartResize(c[0], c[1], 32, compassMinPixels, compassMaxPixels)
		if err != nil || h != c[2] || w != c[3] {
			t.Errorf("smartResize(%d, %d) = %d, %d, %v; want %d, %d", c[0], c[1], h, w, err, c[2], c[3])
		}
	}
	if _, _, err := smartResize(1, 300, 32, compassMinPixels, compassMaxPixels); err == nil {
		t.Error("an aspect ratio over 200 was accepted")
	}
}

func TestPyRound(t *testing.T) {
	in := []float64{0.5, 1.5, 2.5, 2.4999, 3.5, 40.5, 41.5}
	want := []float64{0, 2, 2, 2, 4, 40, 42}
	for i, x := range in {
		if got := pyRound(x); got != want[i] {
			t.Errorf("pyRound(%v) = %v, want %v", x, got, want[i])
		}
	}
}

func hashBytes(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func hashFloats(v []float32) string {
	b := make([]byte, 4*len(v))
	for i, f := range v {
		binary.LittleEndian.PutUint32(b[i*4:], math.Float32bits(f))
	}
	return hashBytes(b)
}

func TestCompassBicubicMatchesPillowPort(t *testing.T) {
	rgb := make([]byte, 37*23*3)
	for i := range rgb {
		rgb[i] = byte((i*7919 + (i>>3)*31) & 255)
	}
	if got := hashBytes(resizeBicubicRGB(rgb, 37, 23, 64, 32)); got != "cbdf87a12a39bd327cefdebfe9750fdbf954e59194f3c1d0c3a2c41609996b6a" {
		t.Errorf("upscale hash %s", got)
	}
	if got := hashBytes(resizeBicubicRGB(rgb, 37, 23, 20, 50)); got != "964ed0349cea1128221dc4cf6ac029a300a3161cbfa0a45ba2a242027b490fc9" {
		t.Errorf("mixed resize hash %s", got)
	}
}

func TestCompassPreprocess(t *testing.T) {
	img := make([]byte, 70*45*3)
	for i := range img {
		img[i] = byte((i*131 + 17) & 255)
	}
	p, err := preprocessCompass(img, 70, 45, compassMaxPixels)
	if err != nil {
		t.Fatal(err)
	}
	if p.Width != 320 || p.Height != 224 || p.GridH != 14 || p.GridW != 20 || p.Tokens != 70 {
		t.Fatalf("layout %+v", p)
	}
	if got := hashFloats(p.pixels); got != "089ef93633d511165be1c32bd35b05b000431694cbcbe1e5cde80c5aed441553" {
		t.Errorf("pixel_values hash %s", got)
	}
}

func TestCompassPlainText(t *testing.T) {
	p := newPlainText([]string{"<|im_end|>", "<|im_start|>", "<think>", "</think>", "<tool_call>", "<", "<|image|>"})
	got := p.apply("a<|im_end|>b<think></think><<|image|>x<tool_call")
	want := "a<​|im_end|>b<​think><​/think><<​|image|>x<tool_call"
	if got != want {
		t.Errorf("plainText = %q, want %q", got, want)
	}
}

func parseQuestion(t *testing.T, src string) Question {
	t.Helper()
	v, err := ParseJSON([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	return Question{ID: "q", Type: v.Get("type").S, Instructions: v.Get("instructions").S, Criteria: v.Get("criteria")}
}

func TestCompassVerifyText(t *testing.T) {
	// JavaScript's trim removes U+FEFF but keeps U+0085 (Go's TrimSpace does the opposite).
	q := parseQuestion(t, `{"type":"choice","instructions":"\`+`ufeff Pick one \u0085","criteria":{"2":"two","b":{"x":1.5e21},"a":"","c":null}}`)
	const tail = "\nIs the proposed answer correct? Answer Yes or No."
	want := []string{
		"Question: Pick one \u0085\nProposed answer: 2: two" + tail,
		"Question: Pick one \u0085\nProposed answer: b: {\"x\":1.5e+21}" + tail,
		"Question: Pick one \u0085\nProposed answer: a" + tail,
		"Question: Pick one \u0085\nProposed answer: c" + tail,
	}
	for i, w := range want {
		if got := compassVerifyText(q, i); got != w {
			t.Errorf("option %d: %q, want %q", i, got, w)
		}
	}
	n := parseQuestion(t, `{"type":"noul","instructions":"Done?","criteria":{"true":null,"yes":"Yes it is","false":"","no":"nope"}}`)
	if got := compassVerifyText(n, 0); got != "Question: Done?\nProposed answer: No"+tail {
		t.Errorf("noul no: %q", got)
	}
	if got := compassVerifyText(n, 1); got != "Question: Done?\nProposed answer: Yes (Yes it is)"+tail {
		t.Errorf("noul yes: %q", got)
	}
}

func TestCompassAnswer(t *testing.T) {
	q := parseQuestion(t, `{"type":"score","instructions":"x","criteria":["a","b",{"c":1}]}`)
	ans, err := compassAnswer(q, []float64{1.25, -3.5, 2.0}, 1)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(ans)
	var gotV, wantV map[string]any
	_ = json.Unmarshal(got, &gotV)
	_ = json.Unmarshal([]byte(`{"type":"score","confidence":0.677298756163347,"probabilities":{"0":0.3199332786246573,"1":0.002767965211995605,"2":0.677298756163347},"score":1.3573654775386896,"legend":{"0":"a","1":"b","2":"{\"c\":1}"}}`), &wantV)
	gb, _ := json.Marshal(gotV)
	wb, _ := json.Marshal(wantV)
	// math.Exp and V8's Math.exp may differ in the last bit.
	if string(gb) != string(wb) {
		gp := gotV["probabilities"].(map[string]any)
		wp := wantV["probabilities"].(map[string]any)
		for k := range wp {
			if math.Abs(gp[k].(float64)-wp[k].(float64)) > 1e-15 {
				t.Fatalf("answer %s, want %s", gb, wb)
			}
		}
	}
}

func TestCompassPrefixRendering(t *testing.T) {
	got := compassPrefix("Page state:\nhi", 2)
	want := "<|startoftext|><|im_start|>system\n" + compassSystemPrompt + "<|im_end|>\n<|im_start|>user\n" +
		"<|vision_start|><|image|><|vision_end|><|vision_start|><|image|><|vision_end|>Page state:\nhi\n\n"
	if got != want {
		t.Errorf("prefix %q", got)
	}
}

func TestF16ToF32(t *testing.T) {
	cases := map[uint16]float32{0x0000: 0, 0x3c00: 1, 0xc000: -2, 0x7bff: 65504, 0x0001: float32(math.Ldexp(1, -24)),
		0x03ff: float32(1023 * math.Ldexp(1, -24)), 0x0400: float32(math.Ldexp(1, -14)), 0x3555: 0.333251953125}
	for h, want := range cases {
		if got := f16ToF32(h); got != want {
			t.Errorf("f16ToF32(%#04x) = %v, want %v", h, got, want)
		}
	}
	if !math.IsInf(float64(f16ToF32(0x7c00)), 1) || !math.IsNaN(float64(f16ToF32(0x7e00))) || math.Signbit(float64(f16ToF32(0x8000))) != true {
		t.Error("special values")
	}
}

func TestCompassQuestionValidation(t *testing.T) {
	blank := parseQuestion(t, `{"type":"noul","instructions":" 　 "}`)
	if validateCompassQuestion(blank) == nil {
		t.Error("blank instructions were accepted")
	}
	crit := `{`
	for i := 0; i < 27; i++ {
		if i > 0 {
			crit += ","
		}
		crit += `"o` + string(rune('a'+i%26)) + string(rune('a'+i/26)) + `":""`
	}
	crit += `}`
	many := parseQuestion(t, `{"type":"choice","instructions":"x","criteria":`+crit+`}`)
	if validateCompassQuestion(many) == nil {
		t.Error("27 options were accepted")
	}
}
