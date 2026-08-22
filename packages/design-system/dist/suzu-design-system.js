import { Fragment as e, jsx as t, jsxs as n } from "react/jsx-runtime";
import { forwardRef as r, useCallback as i, useEffect as a, useLayoutEffect as o, useRef as s, useState as c } from "react";
import { createPortal as l } from "react-dom";
var u = {
	button: "_button_igkdq_5",
	"size-sm": "_size-sm_igkdq_31",
	"size-md": "_size-md_igkdq_33",
	"size-lg": "_size-lg_igkdq_35",
	"variant-primary": "_variant-primary_igkdq_41",
	"variant-secondary": "_variant-secondary_igkdq_65",
	"variant-ghost": "_variant-ghost_igkdq_85",
	"variant-danger": "_variant-danger_igkdq_103"
};
//#endregion
//#region src/components/Button/Button.tsx
function d({ variant: e = "primary", size: n = "md", className: r, type: i = "button", children: a, ...o }) {
	let s = [
		u.button,
		u[`variant-${e}`],
		u[`size-${n}`],
		r
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ t("button", {
		type: i,
		className: s,
		...o,
		children: a
	});
}
var f = {
	panel: "_panel_i05je_5",
	"intensity-subtle": "_intensity-subtle_i05je_25",
	"intensity-soft": "_intensity-soft_i05je_31",
	"intensity-prominent": "_intensity-prominent_i05je_37"
};
//#endregion
//#region src/components/Glass/GlassPanel.tsx
function p({ as: e = "div", intensity: n = "soft", className: r, style: i, children: a }) {
	let o = [
		f.panel,
		f[`intensity-${n}`],
		r
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ t(e, {
		className: o,
		style: i,
		children: a
	});
}
var m = {
	overlay: "_overlay_17ugj_17",
	"fade-in": "_fade-in_17ugj_1",
	dialog: "_dialog_17ugj_7",
	"pop-in": "_pop-in_17ugj_1",
	"surface-glass": "_surface-glass_17ugj_107",
	"surface-soft": "_surface-soft_17ugj_113",
	"surface-solid": "_surface-solid_17ugj_123",
	header: "_header_17ugj_161",
	title: "_title_17ugj_179",
	close: "_close_17ugj_193",
	body: "_body_17ugj_227",
	footer: "_footer_17ugj_243"
};
//#endregion
//#region src/components/Dialog/Dialog.tsx
function h({ open: e, onClose: r, title: i, children: o, footer: s, surface: c = "glass" }) {
	return a(() => {
		if (!e) return;
		let t = (e) => {
			e.key === "Escape" && r();
		};
		return document.addEventListener("keydown", t), () => document.removeEventListener("keydown", t);
	}, [e, r]), e ? /* @__PURE__ */ t("div", {
		className: m.overlay,
		onMouseDown: r,
		children: /* @__PURE__ */ n("div", {
			role: "dialog",
			"aria-modal": "true",
			"aria-label": typeof i == "string" ? i : void 0,
			className: [m.dialog, m[`surface-${c}`]].join(" "),
			onMouseDown: (e) => e.stopPropagation(),
			children: [
				i != null && /* @__PURE__ */ n("div", {
					className: m.header,
					children: [/* @__PURE__ */ t("h2", {
						className: m.title,
						children: i
					}), /* @__PURE__ */ t("button", {
						type: "button",
						"aria-label": "关闭",
						className: m.close,
						onClick: r,
						children: "×"
					})]
				}),
				/* @__PURE__ */ t("div", {
					className: m.body,
					children: o
				}),
				s != null && /* @__PURE__ */ t("div", {
					className: m.footer,
					children: s
				})
			]
		})
	}) : null;
}
var g = {
	overlay: "_overlay_1bfk0_5",
	"fade-in": "_fade-in_1bfk0_1",
	drawer: "_drawer_1bfk0_21",
	"slide-right": "_slide-right_1bfk0_1",
	"placement-left": "_placement-left_1bfk0_87",
	"slide-left": "_slide-left_1bfk0_1",
	"placement-right": "_placement-right_1bfk0_101",
	header: "_header_1bfk0_117",
	title: "_title_1bfk0_135",
	close: "_close_1bfk0_147",
	body: "_body_1bfk0_181"
};
//#endregion
//#region src/components/Drawer/Drawer.tsx
function _({ open: e, onClose: r, placement: i = "right", title: o, children: s }) {
	if (a(() => {
		if (!e) return;
		let t = (e) => {
			e.key === "Escape" && r();
		};
		return document.addEventListener("keydown", t), () => document.removeEventListener("keydown", t);
	}, [e, r]), !e) return null;
	let c = [g.drawer, i === "left" ? g["placement-left"] : g["placement-right"]].join(" ");
	return /* @__PURE__ */ t("div", {
		className: g.overlay,
		onMouseDown: r,
		children: /* @__PURE__ */ n("aside", {
			role: "dialog",
			"aria-modal": "true",
			"aria-label": typeof o == "string" ? o : void 0,
			className: c,
			onMouseDown: (e) => e.stopPropagation(),
			children: [/* @__PURE__ */ n("div", {
				className: g.header,
				children: [/* @__PURE__ */ t("h2", {
					className: g.title,
					children: o
				}), /* @__PURE__ */ t("button", {
					type: "button",
					"aria-label": "关闭",
					className: g.close,
					onClick: r,
					children: "×"
				})]
			}), /* @__PURE__ */ t("div", {
				className: g.body,
				children: s
			})]
		})
	});
}
var v = {
	pill: "_pill_uoetk_5",
	"tone-success": "_tone-success_uoetk_47",
	"tone-warning": "_tone-warning_uoetk_49",
	"tone-danger": "_tone-danger_uoetk_51",
	"tone-info": "_tone-info_uoetk_53",
	"tone-muted": "_tone-muted_uoetk_55"
};
//#endregion
//#region src/components/Status/Status.tsx
function y({ label: e, tone: n = "muted" }) {
	return /* @__PURE__ */ t("span", {
		className: [v.pill, v[`tone-${n}`]].join(" "),
		children: e
	});
}
var b = {
	switch: "_switch_6ywz1_5",
	track: "_track_6ywz1_33"
}, x = r(function({ checked: e, className: r, ...i }, a) {
	return /* @__PURE__ */ n("label", {
		className: [b.switch, r].filter(Boolean).join(" "),
		children: [/* @__PURE__ */ t("input", {
			ref: a,
			type: "checkbox",
			checked: e,
			...i
		}), /* @__PURE__ */ t("span", { className: b.track })]
	});
}), S = {
	wrapper: "_wrapper_10z3z_5",
	input: "_input_10z3z_19",
	"size-sm": "_size-sm_10z3z_71",
	"size-md": "_size-md_10z3z_73",
	"size-lg": "_size-lg_10z3z_75",
	"has-prefix": "_has-prefix_10z3z_81",
	"has-suffix": "_has-suffix_10z3z_83",
	affix: "_affix_10z3z_87",
	prefix: "_prefix_10z3z_105",
	suffix: "_suffix_10z3z_107"
}, C = r(function({ prefix: e, suffix: r, size: i = "md", className: a, style: o, ...s }, c) {
	let l = [
		S.input,
		S[`size-${i}`],
		e != null && S["has-prefix"],
		r != null && S["has-suffix"],
		a
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ n("span", {
		className: S.wrapper,
		style: o,
		children: [
			e != null && /* @__PURE__ */ t("span", {
				className: [S.affix, S.prefix].join(" "),
				children: e
			}),
			/* @__PURE__ */ t("input", {
				ref: c,
				className: l,
				...s
			}),
			r != null && /* @__PURE__ */ t("span", {
				className: [S.affix, S.suffix].join(" "),
				children: r
			})
		]
	});
}), w = {
	wrapper: "_wrapper_e6wna_5",
	fullWidth: "_fullWidth_e6wna_17",
	trigger: "_trigger_e6wna_27",
	open: "_open_e6wna_85",
	placeholder: "_placeholder_e6wna_95",
	label: "_label_e6wna_103",
	chevron: "_chevron_e6wna_117",
	chevronOpen: "_chevronOpen_e6wna_133",
	panel: "_panel_e6wna_143",
	"pop-in": "_pop-in_e6wna_1",
	option: "_option_e6wna_213",
	active: "_active_e6wna_251",
	selected: "_selected_e6wna_263",
	check: "_check_e6wna_273",
	disabled: "_disabled_e6wna_321"
};
//#endregion
//#region src/components/Select/Select.tsx
function T({ options: e, value: r, defaultValue: u, onChange: d, placeholder: f = "请选择", disabled: p = !1, fullWidth: m = !1, id: h, ariaLabel: g, className: _ }) {
	let [v, y] = c(!1), [b, x] = c(u ?? ""), [S, C] = c(-1), [T, E] = c(null), D = s(null), O = s(null), k = r === void 0 ? b : r, A = e.find((e) => e.value === k);
	a(() => {
		if (!v) return;
		let e = (e) => {
			let t = e.target;
			D.current?.contains(t) || O.current?.contains(t) || y(!1);
		}, t = (e) => {
			e.key === "Escape" && y(!1);
		};
		return document.addEventListener("mousedown", e), document.addEventListener("keydown", t), () => {
			document.removeEventListener("mousedown", e), document.removeEventListener("keydown", t);
		};
	}, [v]);
	let j = i(() => {
		if (typeof window > "u" || !D.current) return;
		let e = D.current.getBoundingClientRect(), t = window.innerWidth, n = window.innerHeight, r = Math.min(e.width, Math.max(1, t - 16)), i = Math.min(Math.max(8, e.left), Math.max(8, t - 8 - r)), a = n - e.bottom - 8 - 4, o = e.top - 8 - 4, s = a >= 120 || a >= o ? "below" : "above";
		E({
			left: i,
			maxHeight: Math.min(360, Math.max(1, s === "below" ? a : o)),
			placement: s,
			width: r,
			y: s === "below" ? e.bottom + 4 : n - e.top + 4
		});
	}, []);
	o(() => {
		if (!v || p || typeof window > "u") {
			E(null);
			return;
		}
		j(), window.addEventListener("resize", j), window.addEventListener("scroll", j, !0);
		let e = typeof ResizeObserver > "u" || !D.current ? null : new ResizeObserver(j);
		return e?.observe(D.current), () => {
			window.removeEventListener("resize", j), window.removeEventListener("scroll", j, !0), e?.disconnect();
		};
	}, [
		p,
		v,
		j
	]), a(() => {
		v && C(e.findIndex((e) => e.value === k));
	}, [v]);
	let M = i((e) => {
		y(!1), C(-1), r === void 0 && x(e), d?.(e);
	}, [r, d]), N = (t) => {
		if (!p) {
			if ((t.key === "ArrowDown" || t.key === "ArrowUp") && !v) {
				t.preventDefault(), y(!0);
				return;
			}
			if (v) {
				if (t.key === "ArrowDown" || t.key === "ArrowUp") {
					t.preventDefault();
					let n = t.key === "ArrowDown" ? 1 : -1;
					C((t) => ((t < 0 ? -n : t) + n + e.length) % e.length);
				} else t.key === "Enter" && S >= 0 ? (t.preventDefault(), M(e[S].value)) : t.key === "Home" ? (t.preventDefault(), C(0)) : t.key === "End" && (t.preventDefault(), C(e.length - 1));
			}
		}
	}, P = [
		w.wrapper,
		m && w.fullWidth,
		p && w.disabled,
		_
	].filter(Boolean).join(" "), F = T ? {
		bottom: T.placement === "above" ? T.y : "auto",
		left: T.left,
		maxHeight: T.maxHeight,
		right: "auto",
		top: T.placement === "below" ? T.y : "auto",
		visibility: "visible",
		width: T.width
	} : { visibility: "hidden" }, I = v && !p ? /* @__PURE__ */ t("div", {
		ref: O,
		className: w.panel,
		role: "listbox",
		style: F,
		children: e.map((e, r) => {
			let i = e.value === k;
			return /* @__PURE__ */ n("button", {
				type: "button",
				role: "option",
				"aria-selected": i,
				className: [
					w.option,
					i && w.selected,
					r === S && w.active
				].filter(Boolean).join(" "),
				onClick: () => M(e.value),
				onMouseEnter: () => C(r),
				children: [e.label, /* @__PURE__ */ t("svg", {
					className: w.check,
					viewBox: "0 0 16 16",
					fill: "none",
					"aria-hidden": "true",
					children: /* @__PURE__ */ t("path", {
						d: "M3 8.5L6.5 12 13 4.5",
						stroke: "currentColor",
						strokeWidth: "1.8",
						strokeLinecap: "round",
						strokeLinejoin: "round"
					})
				})]
			}, e.value);
		})
	}) : null;
	return /* @__PURE__ */ n("div", {
		ref: D,
		className: P,
		children: [/* @__PURE__ */ n("button", {
			id: h,
			type: "button",
			className: [w.trigger, v && w.open].filter(Boolean).join(" "),
			onClick: () => !p && y((e) => !e),
			onKeyDown: N,
			"aria-label": g,
			"aria-haspopup": "listbox",
			"aria-expanded": v,
			"aria-disabled": p,
			disabled: p,
			children: [A ? /* @__PURE__ */ t("span", {
				className: w.label,
				children: A.label
			}) : /* @__PURE__ */ t("span", {
				className: w.placeholder,
				children: f
			}), /* @__PURE__ */ t("svg", {
				className: [w.chevron, v && w.chevronOpen].filter(Boolean).join(" "),
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				children: /* @__PURE__ */ t("path", {
					d: "M4 6l4 4 4-4",
					stroke: "currentColor",
					strokeWidth: "1.8",
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			})]
		}), I && (typeof document > "u" ? I : l(I, document.body))]
	});
}
var E = { textarea: "_textarea_rlake_5" }, D = r(function({ className: e, style: n, ...r }, i) {
	return /* @__PURE__ */ t("textarea", {
		ref: i,
		className: [E.textarea, e].filter(Boolean).join(" "),
		style: n,
		...r
	});
}), O = {
	header: "_header_4owb0_5",
	copy: "_copy_4owb0_25",
	eyebrow: "_eyebrow_4owb0_33",
	title: "_title_4owb0_49",
	subtitle: "_subtitle_4owb0_67",
	action: "_action_4owb0_83"
};
//#endregion
//#region src/components/PageHeader/PageHeader.tsx
function k({ eyebrow: e, title: r, subtitle: i, action: a, className: o }) {
	return /* @__PURE__ */ n("div", {
		className: [O.header, o].filter(Boolean).join(" "),
		"data-suzu-page-header": !0,
		children: [/* @__PURE__ */ n("div", {
			className: O.copy,
			children: [
				e != null && /* @__PURE__ */ t("div", {
					className: O.eyebrow,
					children: e
				}),
				/* @__PURE__ */ t("h1", {
					className: O.title,
					children: r
				}),
				i != null && /* @__PURE__ */ t("p", {
					className: O.subtitle,
					children: i
				})
			]
		}), a != null && /* @__PURE__ */ t("div", {
			className: O.action,
			children: a
		})]
	});
}
var A = {
	avatar: "_avatar_1ib3c_5",
	initial: "_initial_1ib3c_45",
	"size-sm": "_size-sm_1ib3c_57",
	"size-md": "_size-md_1ib3c_59",
	"size-lg": "_size-lg_1ib3c_61",
	"size-xl": "_size-xl_1ib3c_63"
};
//#endregion
//#region src/components/Avatar/Avatar.tsx
function j({ src: e, name: n, size: r = "md", fallback: i, className: a, style: o }) {
	let s = String(n).trim().slice(0, 1).toUpperCase(), c = [
		A.avatar,
		A[`size-${r}`],
		a
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ t("span", {
		className: c,
		style: o,
		"aria-label": n,
		role: "img",
		children: e ? /* @__PURE__ */ t("img", {
			src: e,
			alt: "",
			draggable: !1
		}) : /* @__PURE__ */ t("span", {
			className: A.initial,
			children: i ?? s
		})
	});
}
var M = {
	banner: "_banner_1bjii_5",
	icon: "_icon_1bjii_27",
	body: "_body_1bjii_41",
	"tone-warning": "_tone-warning_1bjii_53",
	"tone-info": "_tone-info_1bjii_63",
	"tone-danger": "_tone-danger_1bjii_73",
	"tone-success": "_tone-success_1bjii_83",
	"tone-neutral": "_tone-neutral_1bjii_93"
};
//#endregion
//#region src/components/Banner/Banner.tsx
function N({ tone: e = "neutral", icon: r, children: i, className: a, style: o }) {
	let s = [
		M.banner,
		M[`tone-${e}`],
		a
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ n("div", {
		className: s,
		style: o,
		role: e === "danger" ? "alert" : "status",
		children: [r != null && /* @__PURE__ */ t("span", {
			className: M.icon,
			children: r
		}), /* @__PURE__ */ t("div", {
			className: M.body,
			children: i
		})]
	});
}
var P = {
	card: "_card_1ygva_5",
	header: "_header_1ygva_25",
	copy: "_copy_1ygva_41",
	title: "_title_1ygva_49",
	description: "_description_1ygva_65",
	action: "_action_1ygva_79",
	body: "_body_1ygva_87"
};
//#endregion
//#region src/components/Card/Card.tsx
function F({ title: e, description: r, action: i, children: a, className: o, style: s }) {
	let c = [P.card, o].filter(Boolean).join(" ");
	return /* @__PURE__ */ n("article", {
		className: c,
		style: s,
		children: [e != null && /* @__PURE__ */ n("div", {
			className: P.header,
			children: [/* @__PURE__ */ n("div", {
				className: P.copy,
				children: [/* @__PURE__ */ t("h3", {
					className: P.title,
					children: e
				}), r != null && /* @__PURE__ */ t("p", {
					className: P.description,
					children: r
				})]
			}), i != null && /* @__PURE__ */ t("div", {
				className: P.action,
				children: i
			})]
		}), /* @__PURE__ */ t("div", {
			className: P.body,
			children: a
		})]
	});
}
var I = {
	wrap: "_wrap_1hvcc_7",
	message: "_message_1hvcc_21",
	user: "_user_1hvcc_37",
	avatar: "_avatar_1hvcc_45",
	bubble: "_bubble_1hvcc_53",
	live: "_live_1hvcc_123",
	mediaOnly: "_mediaOnly_1hvcc_137",
	text: "_text_1hvcc_151",
	meta: "_meta_1hvcc_167",
	time: "_time_1hvcc_181",
	timeline: "_timeline_1hvcc_197"
};
//#endregion
//#region src/components/ChatBubble/ChatBubble.tsx
function ee({ align: r = "left", avatar: i, meta: a, time: o, timeInline: s = !1, live: c = !1, mediaOnly: l = !1, children: u, className: d, style: f }) {
	let p = [
		I.message,
		r === "right" && I.user,
		c && I.live,
		l && I.mediaOnly,
		d
	].filter(Boolean).join(" "), m = /* @__PURE__ */ n(e, { children: [i != null && /* @__PURE__ */ t("div", {
		className: I.avatar,
		children: i
	}), /* @__PURE__ */ n("div", {
		className: I.bubble,
		children: [
			a != null && /* @__PURE__ */ t("div", {
				className: I.meta,
				children: a
			}),
			/* @__PURE__ */ t("div", {
				className: I.text,
				children: u
			}),
			o != null && s && /* @__PURE__ */ t("div", {
				className: I.time,
				children: o
			})
		]
	})] });
	return o != null && !s ? /* @__PURE__ */ n("div", {
		className: I.wrap,
		style: f,
		children: [/* @__PURE__ */ t("div", {
			className: I.timeline,
			children: o
		}), /* @__PURE__ */ t("div", {
			className: p,
			children: m
		})]
	}) : /* @__PURE__ */ t("div", {
		className: p,
		style: f,
		children: m
	});
}
var L = {
	composer: "_composer_1ooh5_7",
	surface: "_surface_1ooh5_27",
	textarea: "_textarea_1ooh5_51",
	footer: "_footer_1ooh5_115",
	tools: "_tools_1ooh5_117",
	submitArea: "_submitArea_1ooh5_119",
	tool: "_tool_1ooh5_117",
	staticTool: "_staticTool_1ooh5_151",
	isActive: "_isActive_1ooh5_185",
	sendButton: "_sendButton_1ooh5_245"
};
//#endregion
//#region src/components/ChatComposer/ChatComposer.tsx
function te({ placeholder: r = "输入消息（Enter 发送；Shift+Enter 换行）", onSend: i, disabled: a = !1, maxLength: o = 2e4, tools: s, className: l, style: u }) {
	let [d, f] = c(""), p = !a && d.trim().length > 0, m = () => {
		p && (i?.(d.trim()), f(""));
	};
	return /* @__PURE__ */ t("div", {
		className: [L.composer, l].filter(Boolean).join(" "),
		style: u,
		children: /* @__PURE__ */ n("div", {
			className: L.surface,
			children: [/* @__PURE__ */ t("textarea", {
				className: L.textarea,
				value: d,
				rows: 3,
				maxLength: o,
				placeholder: r,
				disabled: a,
				onChange: (e) => f(e.target.value),
				onKeyDown: (e) => {
					e.key === "Enter" && !e.shiftKey && (e.preventDefault(), m());
				}
			}), /* @__PURE__ */ n("div", {
				className: L.footer,
				children: [/* @__PURE__ */ t("div", {
					className: L.tools,
					"aria-label": "聊天工具",
					children: s ?? /* @__PURE__ */ n(e, { children: [
						/* @__PURE__ */ t("button", {
							type: "button",
							className: L.tool,
							"aria-label": "表情",
							title: "表情",
							disabled: a,
							children: /* @__PURE__ */ t(re, {})
						}),
						/* @__PURE__ */ t("span", {
							className: L.staticTool,
							title: "附件",
							"aria-hidden": "true",
							children: /* @__PURE__ */ t(ie, {})
						}),
						/* @__PURE__ */ t("span", {
							className: L.staticTool,
							title: "文件",
							"aria-hidden": "true",
							children: /* @__PURE__ */ t(z, {})
						}),
						/* @__PURE__ */ t("span", {
							className: L.staticTool,
							title: "截图",
							"aria-hidden": "true",
							children: /* @__PURE__ */ t(ae, {})
						}),
						/* @__PURE__ */ t("span", {
							className: L.staticTool,
							title: "语音输入",
							"aria-hidden": "true",
							children: /* @__PURE__ */ t(oe, {})
						})
					] })
				}), /* @__PURE__ */ n("div", {
					className: L.submitArea,
					children: [/* @__PURE__ */ t("span", {
						className: L.staticTool,
						title: "语音消息",
						"aria-hidden": "true",
						children: /* @__PURE__ */ t(se, {})
					}), /* @__PURE__ */ t("button", {
						type: "button",
						className: L.sendButton,
						onClick: m,
						disabled: !p,
						children: "发送"
					})]
				})]
			})]
		})
	});
}
var ne = {
	display: "block",
	width: 21,
	height: 21
}, R = (e, n) => /* @__PURE__ */ t("svg", {
	viewBox: "0 0 24 24",
	className: e,
	style: ne,
	"aria-hidden": "true",
	children: n
});
function re({ className: r }) {
	return R(r, /* @__PURE__ */ n(e, { children: [/* @__PURE__ */ t("circle", {
		cx: "12",
		cy: "12",
		r: "8.3"
	}), /* @__PURE__ */ t("path", { d: "M8.4 14.2c.9 1.2 2.1 1.8 3.6 1.8s2.7-.6 3.6-1.8M9 9.5h.01M15 9.5h.01" })] }));
}
function ie({ className: r }) {
	return R(r, /* @__PURE__ */ n(e, { children: [/* @__PURE__ */ t("path", { d: "m12 3 8 4.4v9.2L12 21l-8-4.4V7.4L12 3Z" }), /* @__PURE__ */ t("path", { d: "m4 7.4 8 4.4 8-4.4M12 11.8V21" })] }));
}
function z({ className: e }) {
	return R(e, /* @__PURE__ */ t("path", { d: "M3.5 7.2h6l1.9 2h9.1v8.7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.2Z" }));
}
function ae({ className: r }) {
	return R(r, /* @__PURE__ */ n(e, { children: [
		/* @__PURE__ */ t("circle", {
			cx: "6.4",
			cy: "17.2",
			r: "2.2"
		}),
		/* @__PURE__ */ t("circle", {
			cx: "6.4",
			cy: "6.8",
			r: "2.2"
		}),
		/* @__PURE__ */ t("path", { d: "m8.2 8.2 10.3 7.1M8.2 15.8l4-2.8" })
	] }));
}
function oe({ className: r }) {
	return R(r, /* @__PURE__ */ n(e, { children: [/* @__PURE__ */ t("rect", {
		x: "8.5",
		y: "3",
		width: "7",
		height: "12",
		rx: "3.5"
	}), /* @__PURE__ */ t("path", { d: "M5.8 11.5a6.2 6.2 0 0 0 12.4 0M12 17.7V21M8.5 21h7" })] }));
}
function se({ className: r }) {
	return R(r, /* @__PURE__ */ n(e, { children: [/* @__PURE__ */ t("path", { d: "M4 14h3.2L12 18V6L7.2 10H4v4Z" }), /* @__PURE__ */ t("path", { d: "M15 9.2a4.2 4.2 0 0 1 0 5.6M17.8 6.4a8.1 8.1 0 0 1 0 11.2" })] }));
}
var B = {
	file: "_file_1pjt2_5",
	fileRow: "_fileRow_1pjt2_33",
	fileIcon: "_fileIcon_1pjt2_49",
	copy: "_copy_1pjt2_73",
	kind: "_kind_1pjt2_87",
	name: "_name_1pjt2_97",
	size: "_size_1pjt2_115"
};
//#endregion
//#region src/components/ChatFile/ChatFile.tsx
function ce({ name: e, size: r, label: i = "文件", onClick: a, className: o }) {
	return /* @__PURE__ */ t("div", {
		role: "button",
		tabIndex: 0,
		className: [B.file, o].filter(Boolean).join(" "),
		onClick: a,
		onKeyDown: (e) => {
			(e.key === "Enter" || e.key === " ") && a && (e.preventDefault(), a());
		},
		children: /* @__PURE__ */ n("div", {
			className: B.fileRow,
			children: [/* @__PURE__ */ t("div", {
				className: B.fileIcon,
				children: /* @__PURE__ */ t(le, {})
			}), /* @__PURE__ */ n("div", {
				className: B.copy,
				children: [
					/* @__PURE__ */ t("span", {
						className: B.kind,
						children: i
					}),
					/* @__PURE__ */ t("strong", {
						className: B.name,
						children: e
					}),
					r != null && /* @__PURE__ */ t("span", {
						className: B.size,
						children: r
					})
				]
			})]
		})
	});
}
function le() {
	return /* @__PURE__ */ n("svg", {
		viewBox: "0 0 16 16",
		width: "17",
		height: "17",
		fill: "none",
		"aria-hidden": "true",
		children: [
			/* @__PURE__ */ t("path", {
				d: "M3 1.5h6l4 4v9h-10v-13z",
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinejoin: "round"
			}),
			/* @__PURE__ */ t("path", {
				d: "M9 1.5v4h4",
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinejoin: "round"
			}),
			/* @__PURE__ */ t("path", {
				d: "M5.5 9h5M5.5 11.5h3",
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinecap: "round"
			})
		]
	});
}
var V = {
	preview: "_preview_m35qt_7",
	image: "_image_m35qt_35",
	overlay: "_overlay_m35qt_63",
	dialog: "_dialog_m35qt_85",
	dialogHead: "_dialogHead_m35qt_113",
	dialogTitle: "_dialogTitle_m35qt_131",
	close: "_close_m35qt_171",
	stage: "_stage_m35qt_213",
	dialogImg: "_dialogImg_m35qt_233",
	nav: "_nav_m35qt_251",
	dialogFoot: "_dialogFoot_m35qt_305",
	jump: "_jump_m35qt_319"
};
//#endregion
//#region src/components/ChatImage/ChatImage.tsx
function H({ src: r, alt: i = "", name: a, gallery: o, onJump: s, className: l }) {
	let [u, d] = c(!1), [f, p] = c(0), m = o && o.length > 0 ? o : [{
		src: r,
		name: a,
		key: void 0,
		messageId: void 0
	}], h = m[f] ?? m[0], g = m.length;
	return /* @__PURE__ */ n(e, { children: [/* @__PURE__ */ t("button", {
		type: "button",
		className: [V.preview, l].filter(Boolean).join(" "),
		onClick: () => {
			let e = o && o.length > 0 ? Math.max(0, o.findIndex((e) => e.src === r)) : 0;
			p(e === -1 ? 0 : e), d(!0);
		},
		"aria-label": "放大查看图片",
		children: /* @__PURE__ */ t("img", {
			className: V.image,
			src: r,
			alt: i,
			loading: "lazy",
			draggable: !1
		})
	}), u && /* @__PURE__ */ t("div", {
		className: V.overlay,
		onClick: () => d(!1),
		children: /* @__PURE__ */ n("section", {
			className: V.dialog,
			role: "dialog",
			"aria-modal": "true",
			"aria-label": "图片预览",
			onClick: (e) => e.stopPropagation(),
			children: [
				/* @__PURE__ */ n("header", {
					className: V.dialogHead,
					children: [/* @__PURE__ */ n("div", {
						className: V.dialogTitle,
						children: [/* @__PURE__ */ t("strong", { children: h?.name || "图片" }), /* @__PURE__ */ n("span", { children: [
							f + 1,
							" / ",
							g
						] })]
					}), /* @__PURE__ */ t("button", {
						type: "button",
						className: V.close,
						onClick: () => d(!1),
						"aria-label": "关闭图片预览",
						children: "×"
					})]
				}),
				/* @__PURE__ */ n("div", {
					className: V.stage,
					children: [
						/* @__PURE__ */ t("button", {
							type: "button",
							className: V.nav,
							onClick: () => p((e) => Math.max(0, e - 1)),
							disabled: f <= 0,
							"aria-label": "上一张",
							children: "‹"
						}),
						/* @__PURE__ */ t("img", {
							className: V.dialogImg,
							src: h?.src,
							alt: i
						}),
						/* @__PURE__ */ t("button", {
							type: "button",
							className: V.nav,
							onClick: () => p((e) => Math.min(g - 1, e + 1)),
							disabled: f >= g - 1,
							"aria-label": "下一张",
							children: "›"
						})
					]
				}),
				/* @__PURE__ */ t("footer", {
					className: V.dialogFoot,
					children: /* @__PURE__ */ t("button", {
						type: "button",
						className: V.jump,
						onClick: () => s?.(h),
						children: "跳转到图片所在位置"
					})
				})
			]
		})
	})] });
}
var U = {
	voice: "_voice_1yr99_5",
	toggle: "_toggle_1yr99_35",
	toggleIcon: "_toggleIcon_1yr99_79",
	iconPlay: "_iconPlay_1yr99_91",
	content: "_content_1yr99_101",
	wave: "_wave_1yr99_115",
	bar: "_bar_1yr99_131",
	playing: "_playing_1yr99_153",
	"voice-pulse": "_voice-pulse_1yr99_1",
	meta: "_meta_1yr99_199",
	progress: "_progress_1yr99_213",
	progressFill: "_progressFill_1yr99_229",
	time: "_time_1yr99_243"
}, W = [
	35,
	62,
	46,
	84,
	56,
	92,
	48,
	74,
	39,
	66,
	45,
	78
], G = 170, K = 320;
function ue(e) {
	return Math.min(K, Math.max(G, 150 + e * 2.2));
}
var de = 14;
function fe(e) {
	let t = (e - G) / 150;
	return Math.round(de + 12 * t);
}
function pe(e) {
	let t = Math.floor(e / 60), n = Math.floor(e % 60);
	return `${t}:${String(n).padStart(2, "0")}`;
}
function me(e) {
	return Math.max(0, Math.round(e));
}
function he({ duration: r = 0, progress: i, playing: a, onToggle: o, className: s, style: l }) {
	let [u, d] = c(!1), [f, p] = c(0), m = me(r), h = a === void 0 ? u : a, g = i === void 0 ? f : i, _ = ue(m), v = Array.from({ length: fe(_) }, (e, t) => W[t % W.length]), y = () => {
		let e = !h;
		if (a === void 0) {
			if (d(e), e) {
				let e = setInterval(() => {
					p((t) => t >= 100 ? (clearInterval(e), d(!1), 100) : Math.min(100, t + 2));
				}, 200);
				return;
			}
			p(0);
		}
		o?.(e);
	}, b = [
		U.voice,
		h && U.playing,
		s
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ n("div", {
		className: b,
		style: {
			...l,
			width: _
		},
		children: [/* @__PURE__ */ t("button", {
			type: "button",
			className: U.toggle,
			onClick: y,
			"aria-label": h ? "暂停" : "播放",
			children: /* @__PURE__ */ t("svg", {
				className: U.toggleIcon,
				viewBox: "0 0 14 14",
				fill: "currentColor",
				"aria-hidden": "true",
				children: h ? /* @__PURE__ */ n(e, { children: [/* @__PURE__ */ t("rect", {
					x: "3",
					y: "2",
					width: "3",
					height: "10",
					rx: "1"
				}), /* @__PURE__ */ t("rect", {
					x: "8",
					y: "2",
					width: "3",
					height: "10",
					rx: "1"
				})] }) : /* @__PURE__ */ t("path", {
					className: U.iconPlay,
					d: "M4 2.2v9.6a.5.5 0 0 0 .77.42l7.4-4.8a.5.5 0 0 0 0-.84l-7.4-4.8a.5.5 0 0 0-.77.42z"
				})
			})
		}), /* @__PURE__ */ n("div", {
			className: U.content,
			children: [/* @__PURE__ */ t("div", {
				className: U.wave,
				children: v.map((e, n) => /* @__PURE__ */ t("i", {
					className: U.bar,
					style: { "--voice-bar-height": `${e}%` }
				}, n))
			}), /* @__PURE__ */ n("div", {
				className: U.meta,
				children: [/* @__PURE__ */ t("div", {
					className: U.progress,
					children: /* @__PURE__ */ t("span", {
						className: U.progressFill,
						style: { width: `${g}%` }
					})
				}), /* @__PURE__ */ t("span", {
					className: U.time,
					children: pe(m)
				})]
			})]
		})]
	});
}
var q = {
	nav: "_nav_1d2tm_1",
	item: "_item_1d2tm_17",
	active: "_active_1d2tm_65",
	itemActive: "_itemActive_1d2tm_67",
	icon: "_icon_1d2tm_87",
	label: "_label_1d2tm_119"
};
//#endregion
//#region src/components/SideNav/SideNav.tsx
function ge({ children: e, className: n, style: r }) {
	return /* @__PURE__ */ t("nav", {
		className: [q.nav, n].filter(Boolean).join(" "),
		style: r,
		children: e
	});
}
function _e({ active: e = !1, icon: r, onClick: i, children: a, className: o }) {
	let s = [
		q.item,
		e && q.itemActive,
		o
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ n("button", {
		type: "button",
		className: s,
		onClick: i,
		"aria-current": e ? "page" : void 0,
		children: [r != null && /* @__PURE__ */ t("span", {
			className: q.icon,
			children: r
		}), /* @__PURE__ */ t("span", {
			className: q.label,
			children: a
		})]
	});
}
var J = {
	row: "_row_1doyl_5",
	interactive: "_interactive_1doyl_37",
	icon: "_icon_1doyl_45",
	copy: "_copy_1doyl_87",
	title: "_title_1doyl_97",
	description: "_description_1doyl_121",
	action: "_action_1doyl_143"
};
//#endregion
//#region src/components/ListRow/ListRow.tsx
function ve({ icon: e, title: r, description: i, action: a, interactive: o = !0, onClick: s, className: c }) {
	let l = [
		J.row,
		o && J.interactive,
		c
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ n(o ? "button" : "div", {
		type: o ? "button" : void 0,
		className: l,
		onClick: o ? s : void 0,
		children: [
			e != null && /* @__PURE__ */ t("span", {
				className: J.icon,
				children: e
			}),
			/* @__PURE__ */ n("span", {
				className: J.copy,
				children: [/* @__PURE__ */ t("span", {
					className: J.title,
					children: r
				}), i != null && /* @__PURE__ */ t("span", {
					className: J.description,
					children: i
				})]
			}),
			a != null && /* @__PURE__ */ t("span", {
				className: J.action,
				children: a
			})
		]
	});
}
var Y = {
	row: "_row_1cv3d_5",
	selected: "_selected_1cv3d_47",
	rowActive: "_rowActive_1cv3d_49",
	avatar: "_avatar_1cv3d_59",
	copy: "_copy_1cv3d_67",
	name: "_name_1cv3d_77",
	subtitle: "_subtitle_1cv3d_99",
	meta: "_meta_1cv3d_119"
};
//#endregion
//#region src/components/Roster/Roster.tsx
function ye({ avatar: e, name: r, subtitle: i, meta: a, selected: o = !1, onClick: s, className: c }) {
	let l = [
		Y.row,
		o && Y.rowActive,
		c
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ n("button", {
		type: "button",
		className: l,
		onClick: s,
		"aria-pressed": o,
		children: [
			/* @__PURE__ */ t("span", {
				className: Y.avatar,
				children: e
			}),
			/* @__PURE__ */ n("span", {
				className: Y.copy,
				children: [/* @__PURE__ */ t("span", {
					className: Y.name,
					children: r
				}), i != null && /* @__PURE__ */ t("span", {
					className: Y.subtitle,
					children: i
				})]
			}),
			a != null && /* @__PURE__ */ t("span", {
				className: Y.meta,
				children: a
			})
		]
	});
}
var X = {
	tabs: "_tabs_1hszd_5",
	fullWidth: "_fullWidth_1hszd_33",
	tab: "_tab_1hszd_5",
	active: "_active_1hszd_85",
	tabActive: "_tabActive_1hszd_87",
	"size-md": "_size-md_1hszd_111",
	"size-lg": "_size-lg_1hszd_113"
};
//#endregion
//#region src/components/Tabs/Tabs.tsx
function be({ items: e, active: r, onChange: i, size: a = "sm", fullWidth: o = !1, className: s }) {
	let c = [
		X.tabs,
		o && X.fullWidth,
		s
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ t("div", {
		className: c,
		role: "tablist",
		children: e.map((e) => {
			let t = e.value === r;
			return /* @__PURE__ */ n("button", {
				type: "button",
				role: "tab",
				"aria-selected": t,
				className: [
					X.tab,
					X[`size-${a}`],
					t && X.tabActive
				].filter(Boolean).join(" "),
				onClick: () => i?.(e.value),
				children: [e.icon, e.label]
			}, e.value);
		})
	});
}
var Z = {
	panel: "_panel_1322h_5",
	symbol: "_symbol_1322h_31",
	title: "_title_1322h_73",
	description: "_description_1322h_87",
	action: "_action_1322h_103"
};
//#endregion
//#region src/components/Empty/Empty.tsx
function xe({ icon: e, title: r, description: i, action: a, className: o, style: s }) {
	return /* @__PURE__ */ n("div", {
		className: [Z.panel, o].filter(Boolean).join(" "),
		style: s,
		children: [
			e != null && /* @__PURE__ */ t("div", {
				className: Z.symbol,
				children: e
			}),
			/* @__PURE__ */ t("h3", {
				className: Z.title,
				children: r
			}),
			i != null && /* @__PURE__ */ t("p", {
				className: Z.description,
				children: i
			}),
			a != null && /* @__PURE__ */ t("div", {
				className: Z.action,
				children: a
			})
		]
	});
}
var Q = {
	scroll: "_scroll_rujqo_5",
	table: "_table_rujqo_13",
	header: "_header_rujqo_27",
	cell: "_cell_rujqo_49",
	row: "_row_rujqo_69",
	"align-right": "_align-right_rujqo_77",
	striped: "_striped_rujqo_87"
};
//#endregion
//#region src/components/Table/Table.tsx
function Se({ columns: e, data: r, striped: i = !1, className: a, style: o }) {
	return /* @__PURE__ */ t("div", {
		className: [Q.scroll, a].filter(Boolean).join(" "),
		style: o,
		children: /* @__PURE__ */ n("table", {
			className: [Q.table, i && Q.striped].filter(Boolean).join(" "),
			children: [/* @__PURE__ */ t("thead", { children: /* @__PURE__ */ t("tr", { children: e.map((e) => /* @__PURE__ */ t("th", {
				className: [Q.header, e.align === "right" && Q["align-right"]].filter(Boolean).join(" "),
				style: {
					width: e.width == null ? void 0 : e.width,
					textAlign: e.align
				},
				children: e.label
			}, e.key)) }) }), /* @__PURE__ */ t("tbody", { children: r.map((n, r) => /* @__PURE__ */ t("tr", {
				className: Q.row,
				children: e.map((e) => /* @__PURE__ */ t("td", {
					className: [Q.cell, e.align === "right" && Q["align-right"]].filter(Boolean).join(" "),
					style: { textAlign: e.align },
					children: e.render ? e.render(n) : String(n[e.key] ?? "")
				}, e.key))
			}, r)) })]
		})
	});
}
var $ = {
	board: "_board_5xv04_5",
	"layout-compact": "_layout-compact_5xv04_15",
	"layout-fill": "_layout-fill_5xv04_27",
	head: "_head_5xv04_43",
	title: "_title_5xv04_59",
	controls: "_controls_5xv04_73",
	navButton: "_navButton_5xv04_85",
	todayButton: "_todayButton_5xv04_125",
	iconButton: "_iconButton_5xv04_163",
	weekdays: "_weekdays_5xv04_195",
	grid: "_grid_5xv04_197",
	"grid-compact": "_grid-compact_5xv04_259",
	"grid-fill": "_grid-fill_5xv04_269",
	day: "_day_5xv04_287",
	blank: "_blank_5xv04_289",
	dayWithDots: "_dayWithDots_5xv04_351",
	dayNumber: "_dayNumber_5xv04_361",
	selected: "_selected_5xv04_385",
	daySelected: "_daySelected_5xv04_387",
	today: "_today_5xv04_1",
	dayToday: "_dayToday_5xv04_413",
	dots: "_dots_5xv04_447",
	dot: "_dot_5xv04_447",
	holiday: "_holiday_5xv04_481",
	dotHoliday: "_dotHoliday_5xv04_483"
};
//#endregion
//#region src/components/Calendar/Calendar.tsx
function Ce({ year: e, month: r, events: i = {}, selected: a, onSelect: o, onPrevMonth: s, onNextMonth: c, onGoToday: l, controls: u, weekdayLabels: d = [
	"一",
	"二",
	"三",
	"四",
	"五",
	"六",
	"日"
], layout: f = "content", className: p }) {
	let m = d.length === 7 ? d : [
		"一",
		"二",
		"三",
		"四",
		"五",
		"六",
		"日"
	], h = (new Date(e, r, 1).getDay() + 6) % 7, g = new Date(e, r + 1, 0).getDate(), _ = /* @__PURE__ */ new Date(), v = `${_.getFullYear()}-${String(_.getMonth() + 1).padStart(2, "0")}-${String(_.getDate()).padStart(2, "0")}`, y = (e) => String(e).padStart(2, "0"), b = (t) => `${e}-${y(r + 1)}-${y(t)}`, x = [];
	for (let e = 0; e < h; e++) x.push(/* @__PURE__ */ t("span", {
		className: $.blank,
		"aria-hidden": !0
	}, `b${e}`));
	for (let e = 1; e <= g; e++) {
		let r = b(e), s = r === v, c = r === a, l = i[r] ?? [], u = l.length > 0;
		x.push(/* @__PURE__ */ n("button", {
			type: "button",
			className: [
				$.day,
				u && $.dayWithDots,
				s && $.dayToday,
				c && $.daySelected
			].filter(Boolean).join(" "),
			onClick: () => o?.(r),
			children: [/* @__PURE__ */ t("span", {
				className: $.dayNumber,
				children: e
			}), u && /* @__PURE__ */ t("i", {
				className: $.dots,
				children: l.map((e, n) => /* @__PURE__ */ t("b", { className: [$.dot, e === "holiday" && $.dotHoliday].filter(Boolean).join(" ") }, n))
			})]
		}, r));
	}
	let S = `${e} 年 ${r + 1} 月`;
	return /* @__PURE__ */ n("div", {
		className: [
			$.board,
			f === "compact" && $["layout-compact"],
			f === "fill" && $["layout-fill"],
			p
		].filter(Boolean).join(" "),
		children: [
			/* @__PURE__ */ n("div", {
				className: $.head,
				children: [/* @__PURE__ */ t("h4", {
					className: $.title,
					children: S
				}), /* @__PURE__ */ n("div", {
					className: $.controls,
					children: [
						u,
						/* @__PURE__ */ t("button", {
							type: "button",
							className: $.navButton,
							onClick: s,
							"aria-label": "上一月",
							children: "‹"
						}),
						/* @__PURE__ */ t("button", {
							type: "button",
							className: $.todayButton,
							onClick: l,
							children: "今天"
						}),
						/* @__PURE__ */ t("button", {
							type: "button",
							className: $.navButton,
							onClick: c,
							"aria-label": "下一月",
							children: "›"
						})
					]
				})]
			}),
			/* @__PURE__ */ t("div", {
				className: $.weekdays,
				children: m.map((e) => /* @__PURE__ */ t("span", { children: e }, e))
			}),
			/* @__PURE__ */ t("div", {
				className: [
					$.grid,
					f === "compact" && $["grid-compact"],
					f === "fill" && $["grid-fill"]
				].filter(Boolean).join(" "),
				children: x
			})
		]
	});
}
//#endregion
export { j as Avatar, N as Banner, d as Button, Ce as Calendar, F as Card, ee as ChatBubble, te as ChatComposer, ce as ChatFile, H as ChatImage, he as ChatVoice, h as Dialog, _ as Drawer, xe as Empty, p as GlassPanel, C as Input, ve as ListRow, k as PageHeader, ye as Roster, T as Select, ge as SideNav, _e as SideNavItem, y as Status, x as Switch, Se as Table, be as Tabs, D as Textarea };
