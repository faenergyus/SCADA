/**
 * Gibbs Wave Equation — Downhole Card Calculator
 *
 * Transfer matrix (Fourier) solution of the 1D damped wave equation.
 * Decomposes surface card into Fourier harmonics, propagates each through
 * the rod string using per-section transfer matrices, then reconstructs
 * the downhole card via inverse DFT.
 *
 * Properly handles tapered rod strings — each section has its own
 * 2×2 transfer matrix accounting for impedance (E·A) and wave speed.
 *
 * Reference: Gibbs, S.G. SPE-588-PA (1963); Everitt & Jennings (1992)
 */

var WaveEquation = (function () {
    'use strict';

    var STEEL_WEIGHT_DENSITY = 0.2833;  // lbf/in³ (weight density)
    var STEEL_ELASTICITY = 30.5e6;      // psi
    var GRAVITY = 386.4;                // in/s²
    var PI = Math.PI;

    function buildRodModel(rodSections, wellDetails) {
        if (!rodSections || rodSections.length === 0) return null;

        var sections = rodSections.slice().sort(function (a, b) {
            return (a.RodNum || 0) - (b.RodNum || 0);
        });

        var totalLength = 0;
        var model = [];

        for (var i = 0; i < sections.length; i++) {
            var s = sections[i];
            var lenIn = (s.Length || 0) * 12;
            var diam = s.Diameter || 0.75;
            var E = s.Elasticity || STEEL_ELASTICITY;
            var matlID = s.RodMatlID || 1;
            var wDens = (matlID === 4) ? 0.065 : STEEL_WEIGHT_DENSITY;
            var area = PI * diam * diam / 4;

            model.push({
                length: lenIn,
                diameter: diam,
                area: area,
                E: E,
                EA: E * area,
                wDens: wDens,
                waveSpeed: Math.sqrt(E * GRAVITY / wDens),
                weightPerIn: wDens * area,
            });
            totalLength += lenIn;
        }

        var pumpDepth = (wellDetails.PumpDepth || 0) * 12;
        if (pumpDepth === 0) pumpDepth = totalLength;

        return {
            sections: model,
            totalLength: totalLength,
            pumpDepth: pumpDepth,
            spm: wellDetails.SPM || 8,
            strokeLength: wellDetails.StrokeLength || 100,
            plungerDiam: wellDetails.PlungerDiam || 1.5,
            fluidSG: wellDetails.FluidSpecificGravity || wellDetails.WaterSG || 1.0,
            tubingPressure: wellDetails.TubingPressure || 0,
            casingPressure: wellDetails.CasingPressure || 0,
        };
    }

    /**
     * Calculate downhole card from surface card using transfer matrix method.
     *
     * For each Fourier harmonic n of the surface card:
     *   1. Compute complex wave number κ_n for each rod section (includes damping)
     *   2. Build 2×2 transfer matrix T_j(κ_n) for each section j
     *   3. Multiply: [u_pump, F_pump]^T = T_last · ... · T_1 · [u_surf, F_surf]^T
     *
     * Transfer matrix for section j:
     *   | cos(κL)           sin(κL)/(EA·κ) |
     *   | -EA·κ·sin(κL)     cos(κL)        |
     */
    function calculateDownholeCard(surfacePosition, surfaceLoad, rodModel, options) {
        if (!rodModel || !surfacePosition || !surfaceLoad) return null;
        var M = surfacePosition.length;
        if (M < 10) return null;

        var opts = options || {};
        var dampCoeff = opts.dampingFactor != null ? opts.dampingFactor : 0.4;
        var nHarm = Math.floor(M / 2);

        var omega = 2 * PI * rodModel.spm / 60;  // fundamental angular frequency (rad/s)

        // ---------------------------------------------------------------
        // Step 1: DFT of surface position and load
        //   X[n] = Σ_{k=0}^{M-1} x[k] · e^{-i·2π·nk/M}
        // ---------------------------------------------------------------
        var surfPosRe = new Float64Array(nHarm + 1);
        var surfPosIm = new Float64Array(nHarm + 1);
        var surfLoadRe = new Float64Array(nHarm + 1);
        var surfLoadIm = new Float64Array(nHarm + 1);

        for (var n = 0; n <= nHarm; n++) {
            var pr = 0, pi = 0, lr = 0, li = 0;
            for (var k = 0; k < M; k++) {
                var angle = 2 * PI * n * k / M;
                var ca = Math.cos(angle);
                var sa = Math.sin(angle);
                pr += surfacePosition[k] * ca;
                pi -= surfacePosition[k] * sa;
                lr += surfaceLoad[k] * ca;
                li -= surfaceLoad[k] * sa;
            }
            surfPosRe[n] = pr;
            surfPosIm[n] = pi;
            surfLoadRe[n] = lr;
            surfLoadIm[n] = li;
        }

        // ---------------------------------------------------------------
        // Step 2: Propagate each harmonic through rod string
        // ---------------------------------------------------------------
        var pumpPosRe = new Float64Array(nHarm + 1);
        var pumpPosIm = new Float64Array(nHarm + 1);
        var pumpLoadRe = new Float64Array(nHarm + 1);
        var pumpLoadIm = new Float64Array(nHarm + 1);

        for (var n = 0; n <= nHarm; n++) {
            var u_re = surfPosRe[n], u_im = surfPosIm[n];
            var f_re = surfLoadRe[n], f_im = surfLoadIm[n];

            if (n === 0) {
                // DC (static): u grows by elastic stretch F·L/(EA) per section;
                // force constant (gravity handled by buoyant weight subtraction)
                for (var s = 0; s < rodModel.sections.length; s++) {
                    var sec = rodModel.sections[s];
                    var stretchFactor = sec.length / sec.EA;
                    u_re += f_re * stretchFactor;
                    u_im += f_im * stretchFactor;
                }
            } else {
                var omega_n = n * omega;

                // Undamped transfer matrices (real wave numbers)
                for (var s = 0; s < rodModel.sections.length; s++) {
                    var sec = rodModel.sections[s];
                    var c_s = sec.waveSpeed;
                    var EA_s = sec.EA;
                    var L_s = sec.length;

                    // Real wave number: κ = ω_n / c
                    var kappa = omega_n / c_s;
                    var phi = kappa * L_s;

                    var cosPhi = Math.cos(phi);
                    var sinPhi = Math.sin(phi);
                    var EAk = EA_s * kappa;

                    // Transfer matrix (real):
                    // u_new = cos(φ)·u + sin(φ)/(EA·κ)·f
                    // f_new = −EA·κ·sin(φ)·u + cos(φ)·f
                    var u_new_re = cosPhi * u_re + (sinPhi / EAk) * f_re;
                    var u_new_im = cosPhi * u_im + (sinPhi / EAk) * f_im;
                    var f_new_re = -EAk * sinPhi * u_re + cosPhi * f_re;
                    var f_new_im = -EAk * sinPhi * u_im + cosPhi * f_im;

                    u_re = u_new_re;
                    u_im = u_new_im;
                    f_re = f_new_re;
                    f_im = f_new_im;
                }

                // Post-transfer damping: attenuate each harmonic exponentially
                // Higher harmonics traverse more wave-lengths → more damping
                // Factor = exp(−ζ · n·ω·L_total / c_avg)
                var dampFactor = Math.exp(-dampCoeff * omega_n *
                    rodModel.totalLength / rodModel.sections[0].waveSpeed);
                u_re *= dampFactor;
                u_im *= dampFactor;
                f_re *= dampFactor;
                f_im *= dampFactor;
            }

            pumpPosRe[n] = u_re;
            pumpPosIm[n] = u_im;
            pumpLoadRe[n] = f_re;
            pumpLoadIm[n] = f_im;
        }

        // ---------------------------------------------------------------
        // Step 3: Inverse DFT to reconstruct pump card
        //   x[k] = (1/M) · Σ_{n=0}^{M-1} X[n] · e^{i·2π·nk/M}
        //   Using conjugate symmetry: X[M−n] = X[n]* for real signals
        // ---------------------------------------------------------------
        var dhDisp = new Float64Array(M);
        var dhLoad = new Float64Array(M);

        for (var k = 0; k < M; k++) {
            var d = 0, l = 0;
            for (var n = 0; n <= nHarm; n++) {
                var angle = 2 * PI * n * k / M;
                var ca = Math.cos(angle);
                var sa = Math.sin(angle);
                // Real part of X[n]·e^{iθ} = Xr·cos(θ) − Xi·sin(θ)
                var cd = pumpPosRe[n] * ca - pumpPosIm[n] * sa;
                var cl = pumpLoadRe[n] * ca - pumpLoadIm[n] * sa;
                // DC and Nyquist contribute once; all others doubled (conjugate pair)
                if (n === 0 || (n === nHarm && M % 2 === 0)) {
                    d += cd;
                    l += cl;
                } else {
                    d += 2 * cd;
                    l += 2 * cl;
                }
            }
            dhDisp[k] = d / M;
            dhLoad[k] = l / M;
        }

        // ---------------------------------------------------------------
        // Step 4: Normalize displacement and compute net pump load
        // ---------------------------------------------------------------
        var minDH = dhDisp[0];
        for (var t = 1; t < M; t++) {
            if (dhDisp[t] < minDH) minDH = dhDisp[t];
        }

        // Buoyant rod weight: total rod weight minus buoyancy
        var fluidDens = rodModel.fluidSG * 62.4 / 1728;  // lbf/in³
        var buoyFactor = 1 - fluidDens / STEEL_WEIGHT_DENSITY;
        var totalBuoyantWt = 0;
        for (var s = 0; s < rodModel.sections.length; s++) {
            totalBuoyantWt += rodModel.sections[s].weightPerIn *
                              rodModel.sections[s].length * buoyFactor;
        }

        // Net pump load = rod force at pump − buoyant rod weight
        var resultPos = new Array(M);
        var resultLoad = new Array(M);
        for (var t = 0; t < M; t++) {
            resultPos[t] = Math.round((dhDisp[t] - minDH) * 100) / 100;
            resultLoad[t] = Math.round(dhLoad[t] - totalBuoyantWt);
        }

        // Average wave speed for metadata
        var avgC = 0;
        var totalLen = 0;
        for (var s = 0; s < rodModel.sections.length; s++) {
            avgC += rodModel.sections[s].waveSpeed * rodModel.sections[s].length;
            totalLen += rodModel.sections[s].length;
        }
        avgC /= totalLen;

        return {
            position: resultPos,
            load: resultLoad,
            meta: {
                method: 'Gibbs (transfer matrix)',
                nHarmonics: nHarm,
                dampingFactor: dampCoeff,
                pumpDepthFt: Math.round(rodModel.pumpDepth / 12),
                rodSections: rodModel.sections.length,
                avgWaveSpeedFtS: Math.round(avgC / 12),
                buoyantRodWt: Math.round(totalBuoyantWt),
            }
        };
    }

    function idealDownholeCard(rodModel, netStroke) {
        if (!rodModel) return null;
        var plungerArea = PI * rodModel.plungerDiam * rodModel.plungerDiam / 4;
        var fluidLoad = rodModel.fluidSG * 0.433 * (rodModel.pumpDepth / 12) * plungerArea;
        var tubLoad = rodModel.tubingPressure * plungerArea;
        var casLoad = rodModel.casingPressure * plungerArea;
        var upLoad = fluidLoad + tubLoad - casLoad;
        var downLoad = Math.max(0, tubLoad - casLoad);
        var stroke = netStroke || rodModel.strokeLength * 0.9;
        var N = 100, pos = [], load = [];
        for (var i = 0; i < N; i++) {
            var f = i / (N - 1);
            if (f < 0.02) { pos.push(0); load.push(downLoad + (upLoad - downLoad) * f / 0.02); }
            else if (f < 0.5) { pos.push(stroke * (f - 0.02) / 0.48); load.push(upLoad); }
            else if (f < 0.52) { pos.push(stroke); load.push(upLoad - (upLoad - downLoad) * (f - 0.5) / 0.02); }
            else { pos.push(stroke * (1 - (f - 0.52) / 0.48)); load.push(downLoad); }
        }
        return { position: pos, load: load, meta: { fluidLoad: Math.round(upLoad), downstrokeLoad: Math.round(downLoad) }};
    }

    return {
        buildRodModel: buildRodModel,
        calculateDownholeCard: calculateDownholeCard,
        idealDownholeCard: idealDownholeCard,
    };
})();
