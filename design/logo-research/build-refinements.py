from pathlib import Path
from html import escape
root = Path(__file__).resolve().parent
options = [
 ('D', 'Classic + deeper shadow', 'A slightly deeper sage offset, targeting 4% of the body width.', 'refinements/classic-medium-shadow.png'),
 ('E', 'Classic + soft depth', 'Matte shading and rounded edges on the forest-green box.', 'refinements/classic-soft-depth.png'),
 ('H', 'Classic + centered face', 'Face centered on the green front panel, excluding the dark side.', 'refinements/classic-box-family-centered.png'),
 ('G', 'Classic + box-family depth', 'Rightward depth matching the box portraits: about one seventh of the front width.', 'refinements/classic-box-family-depth.png'),
 ('F', 'Classic + depth & shadow', 'Soft matte depth with the deeper sage printed shadow.', 'refinements/classic-depth-shadow.png'),
 ('B', 'Classic + shallow shadow', 'A narrow sage edge, about 2% of the body width.', 'refinements/classic-shallow-shadow.png'),
 ('A', 'Classic', 'Original baseline', 'marks/01-classic.png'),
 ('C', 'Sage + soft depth', 'Light sage, a forest face, and a restrained matte finish.', 'refinements/sage-soft-depth.png'),
]
# Measured front-panel bounds in each 1254px concept image.
# Normalize front width in CSS only; keep the saved image files unchanged.
front_bounds = {'D': (191, 1050, 195), 'E': (191, 1053, 195), 'H': (189, 968, 200)}
cards = ''
for letter, name, caption, src in options:
    samples = ''.join(f'<span><img src="{src}" width="{size}" height="{size}" alt=""><small>{size}</small></span>' for size in [16,24,32,48,64])
    normalized = ''
    if letter in front_bounds:
        x0, x1, y0 = front_bounds[letter]
        scale = 220 / (x1 - x0)
        normalized = f' class="normalized" data-front-fraction="{(x1-x0)/1254}" style="width:{1254*scale}px;height:{1254*scale}px;left:calc(50% - {(x0+x1)/2*scale}px);top:{48-y0*scale}px"'
    cards += f'<article><a class="hero" href="{src}" target="_blank"><img{normalized} src="{src}" alt="{escape(name)}"></a><div class="copy"><small>{letter}</small><h2>{escape(name)}</h2><p>{caption}</p></div><div class="sizes">{samples}</div></article>'
page = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BoxHaven · Classic refinements</title><style>
*{box-sizing:border-box}body{margin:0;background:#f7f6f1;color:#233f36;font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}main{max-width:1320px;margin:auto;padding:36px 28px}a{color:#36745b;text-underline-offset:4px}header{margin-bottom:32px}h1{font-size:40px;letter-spacing:-.04em;margin:26px 0 8px;line-height:1.1}p{margin:0;color:#627169}h2{font-size:20px;letter-spacing:-.025em;margin:4px 0 10px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px}article{display:flex;flex-direction:column;min-width:0;border:1px solid #d7ddd2;border-radius:12px;overflow:hidden;background:#fbfaf6}.hero{position:relative;overflow:hidden;flex:none;display:grid;place-items:center;height:330px;background:#f7f6f1}.hero img{width:100%;height:100%;object-fit:contain;max-height:330px}.hero img.normalized{position:absolute;max-height:none;max-width:none;object-fit:fill}.copy{flex:1;padding:20px;min-height:148px}.copy small{color:#6f8477}.sizes{display:flex;align-items:end;justify-content:center;gap:18px;padding:22px 10px;border-top:1px solid #d7ddd2;background:#f7f6f1}.sizes span{display:flex;flex-direction:column;gap:9px;align-items:center}.sizes img{object-fit:contain}.sizes small{font-size:11px;color:#627169}footer{border-top:1px solid #d7ddd2;margin-top:36px;padding-top:20px;font-size:12px;color:#627169}footer p{max-width:800px;margin-bottom:10px}@media(max-width:800px){.grid{grid-template-columns:1fr}main{padding:24px 18px}h1{font-size:32px}.hero{height:300px}.hero img{max-height:300px}.copy{min-height:0}}
</style><main><header><a href="index.html">← All eight studies & research</a><h1>Classic, with a little depth.</h1><p>H centers the face on the front panel. The first row uses the same 220px front-panel width to compare shadow, depth, and the corrected combination.</p><p style="display:flex;align-items:center;gap:12px;margin-top:16px"><img src="refinements/box-family-reference.png" width="80" height="80" alt="Existing box portrait used as the depth reference">Existing box portrait · shared geometry</p></header><section class="grid">CARDS</section><footer><p>H refines G’s facial alignment. Large D, E, and H previews are normalized by measured front-panel width; the small previews use full-canvas dimensions. G uses the shared box-family direction and targets its 5/35 side-to-front ratio. It is an imagegen approximation; final vector artwork should enforce that ratio. B, D, E, F, G, and H are paper proofs; A and C have transparent backgrounds. These are concepts, with final vector edges and small-size exports still to be drawn.</p><a href="refinements/prompts.json">First-round prompts ↗</a> · <a href="refinements/prompts-round-two.json">Second-round prompts ↗</a> · <a href="refinements/prompts-round-three.json">Combined treatment prompt ↗</a> · <a href="refinements/prompts-round-four.json">Box-family match prompt ↗</a> · <a href="refinements/prompts-round-five.json">Face alignment prompt ↗</a></footer></main></html>'''
(root/'refinements.html').write_text(page.replace('CARDS', cards))
