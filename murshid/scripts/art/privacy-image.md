# Privacy illustration

Asset: `web/art/halftone/privacy-dame-turque.webp`.

Created with the built-in imagegen tool as a stylized derivative of the
user-supplied *Dame Turque* photograph:
<https://cdn8.openculture.com/2019/01/06221419/Dame-Turque-e1546843940789.jpg>.
Style reference: `web/art/halftone/way.webp`.
This generated asset is separate from the deterministic `halftone.py` output;
that script does not regenerate it. The image has a transparent background.
The generated PNG was encoded as WebP with `cwebp -q 82 -alpha_q 90`.

## Generation prompt

Use case: style-transfer. Create a website illustration asset, no text. Input 1 is the historical Dame Turque photograph to stylize; input 2 is the site's gold halftone style reference, not a subject to include. Preserve the seated woman's recognizable pose, historical costume, sofa and architectural setting from input 1. Crop away all the surrounding photographic mount, handwritten marks and caption. Render the photographic scene as a delicate vintage printer's halftone, fine regular stippled dots in warm gold #d9ae55 with pale parchment #f4ead6 highlights, shadows transparent. Keep the seated figure and sofa clear. Horizontal composition about 5:4. Feather outer architectural edges gradually into full transparency; no rectangular frame or border. This asset sits on deep crimson #6c0f1d, so transparent dark areas are essential, not black or cream fill. No invented people, no lettering, no watermark.
