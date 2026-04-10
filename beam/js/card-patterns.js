/**
 * Dyno Card Pattern Database & Diagnostic Engine
 *
 * Classifies downhole dynamometer cards by comparing shape features
 * against known pump condition patterns. Uses geometric analysis
 * (area ratios, load transitions, symmetry) rather than image matching.
 *
 * Sources:
 *   - Theta/XSPOC XDiag condition taxonomy
 *   - API RP 11L2 "Recommended Practice for Electrical Submersible Pump Testing"
 *   - Gibbs, S.G. "Computing Gearbox Torque and Motor Loading" (SPE 18186)
 *   - Industry standard card shape classifications
 */

const CardPatterns = (function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Pattern Database
    // -----------------------------------------------------------------------
    /**
     * Each pattern describes the expected shape features of a downhole card
     * for a specific pump condition.
     *
     * Shape features extracted from each card:
     *   - areaRatio:        actual card area / ideal rectangular card area
     *   - loadRange:        (maxLoad - minLoad) as fraction of ideal fluid load
     *   - upstrokeSlope:    normalized slope of load during upstroke
     *   - downstrokeSlope:  normalized slope of load during downstroke
     *   - tvTransition:     sharpness of load pickup at bottom (TV closing)
     *   - svTransition:     sharpness of load drop at top (SV closing)
     *   - symmetry:         how symmetric the card is about the midpoint
     *   - flatTop:          fraction of upstroke at near-constant load
     *   - flatBottom:       fraction of downstroke at near-constant load
     *   - fluidPoundIdx:    sharp load drop during downstroke (0-1)
     *   - gasCompression:   gradual load buildup during upstroke (0-1)
     */
    // Pattern thresholds calibrated against 64 real XSPOC wells (2026-03-23).
    // Feature statistics computed per XSPOC PumpCondition class and used to set
    // min/max/ideal values for each discriminating feature.
    var PATTERNS = [
        {
            id: 'full_pump',
            name: 'Full Pump',
            severity: 'normal',
            description: 'Pump is operating normally with full fillage. Card is approximately rectangular.',
            operationalMeaning: 'Pump barrel is completely filled with fluid each stroke. Optimal production.',
            actions: ['No action needed', 'Monitor for changes'],
            features: {
                areaRatio: { min: 0.72, ideal: 0.85, max: 1.0 },
                flatBottom: { min: 0.60, ideal: 0.80 },
                tvTransition: { min: 0.8, ideal: 1.0 },
                svTransition: { min: 0.8, ideal: 1.0 },
                fluidPoundIdx: { max: 0.20 },
            },
            weight: 1.0,
        },
        {
            id: 'fluid_pound',
            name: 'Fluid Pound',
            severity: 'warning',
            description: 'Pump barrel not completely filled — plunger hits fluid on downstroke causing sharp load spike. Card shows truncated lower-right corner.',
            operationalMeaning: 'Pump speed exceeds fluid inflow rate. Barrel partially gas-filled. Causes rod and surface equipment fatigue.',
            actions: [
                'Slow pump speed (reduce SPM)',
                'Lower pump if possible',
                'Check for gas interference',
                'Verify fluid level vs pump depth',
            ],
            features: {
                areaRatio: { min: 0.15, ideal: 0.50, max: 0.80 },
                fluidPoundIdx: { min: 0.10, ideal: 0.35 },
                svTransition: { max: 0.55 },
            },
            weight: 1.2,
        },
        {
            id: 'gas_interference',
            name: 'Gas Interference',
            severity: 'warning',
            description: 'Free gas in pump barrel compresses before valves transfer. Card shows gradual load buildup on upstroke and gradual unloading on downstroke — "banana" or "football" shape.',
            operationalMeaning: 'Gas entering pump with fluid. Reduces pump efficiency. Gas must compress before TV opens.',
            actions: [
                'Install or check gas separator/anchor',
                'Lower pump below perforations if possible',
                'Consider gas venting',
                'Check casing pressure management',
            ],
            features: {
                areaRatio: { min: 0.35, ideal: 0.58, max: 0.70 },
                flatBottom: { max: 0.45 },
                flatTop: { max: 0.55 },
                fluidPoundIdx: { max: 0.35 },
            },
            weight: 1.1,
        },
        {
            id: 'tv_leak',
            name: 'Traveling Valve Leak',
            severity: 'warning',
            description: 'Traveling valve not seating properly. Fluid leaks past TV during upstroke. Card shows declining load during upstroke (sloping top).',
            operationalMeaning: 'TV ball or seat worn/damaged. Fluid falls back through TV during upstroke, reducing lift.',
            actions: [
                'Pull rods and replace TV',
                'Check for sand/debris in valve',
                'Monitor for worsening',
            ],
            features: {
                flatTop: { max: 0.55, ideal: 0.40 },
                flatBottom: { min: 0.45, ideal: 0.75 },
                areaRatio: { min: 0.55, max: 0.90 },
                fluidPoundIdx: { max: 0.12 },
            },
            weight: 1.15,
        },
        {
            id: 'sv_leak',
            name: 'Standing Valve Leak',
            severity: 'warning',
            description: 'Standing valve not seating properly. Fluid leaks past SV during downstroke. Card shows rising load during downstroke (sloping bottom).',
            operationalMeaning: 'SV ball or seat worn/damaged. Fluid falls back through SV during downstroke.',
            actions: [
                'Pull tubing and replace SV',
                'Check for sand/debris',
                'Verify SV type matches well conditions',
            ],
            features: {
                flatBottom: { max: 0.55, ideal: 0.35 },
                areaRatio: { min: 0.40, max: 0.90 },
                svTransition: { max: 0.50 },
                fluidPoundIdx: { max: 0.25 },
            },
            weight: 1.15,
        },
        {
            id: 'worn_pump',
            name: 'Worn Pump / Barrel Wear',
            severity: 'caution',
            description: 'Pump barrel or plunger worn — fluid slips past plunger during both strokes. Card appears "squeezed" with reduced area but retains general shape.',
            operationalMeaning: 'Clearance between plunger and barrel increased. Efficiency drops progressively. Both valves may still be OK.',
            actions: [
                'Schedule pump replacement',
                'Monitor efficiency trend',
                'Check sand production levels',
            ],
            features: {
                areaRatio: { min: 0.45, ideal: 0.63, max: 0.78 },
                flatTop: { min: 0.30 },
                flatBottom: { min: 0.25 },
                tvTransition: { min: 0.55 },
                svTransition: { min: 0.55 },
                fluidPoundIdx: { max: 0.28 },
            },
            weight: 0.85,
        },
        {
            id: 'rod_part',
            name: 'Rod Part (Broken Rod)',
            severity: 'critical',
            description: 'Rod string parted — surface carries only weight above break. Card shows minimal load variation, near-zero fluid load.',
            operationalMeaning: 'Rod broken. No pumping action at pump. Well is dead.',
            actions: [
                'Shut down unit immediately',
                'Fish rods',
                'Inspect rod string for cause (fatigue, corrosion, overload)',
            ],
            features: {
                areaRatio: { max: 0.50, ideal: 0.30 },
                flatTop: { max: 0.30 },
                flatBottom: { max: 0.25 },
                fluidPoundIdx: { max: 0.20 },
            },
            weight: 1.3,
        },
        {
            id: 'pump_hitting_down',
            name: 'Pump Hitting Down',
            severity: 'critical',
            description: 'Plunger bottoming out on downstroke — sharp load spike at bottom of stroke. Card shows spike in downstroke load near bottom dead center.',
            operationalMeaning: 'Plunger hitting bottom of barrel or tag bar. Causes rod buckling, barrel damage.',
            actions: [
                'Adjust rod space / rod length',
                'Check for tubing stretch',
                'Verify pump spacing',
                'Shut down if severe',
            ],
            features: {
                areaRatio: { min: 0.5, max: 0.95 },
                bottomSpike: { min: 0.5, ideal: 0.8 },
            },
            weight: 1.3,
        },
        {
            id: 'pump_hitting_up',
            name: 'Pump Hitting Up',
            severity: 'critical',
            description: 'Plunger topping out on upstroke — sharp load spike at top of stroke. Card shows spike in upstroke load near top dead center.',
            operationalMeaning: 'Plunger hitting top of barrel or overtravel on upstroke. Can damage pump barrel, seating nipple, or rod string.',
            actions: [
                'Adjust rod space / rod length',
                'Check for fluid pound (causes overtravel)',
                'Verify stroke length setting',
                'Shut down if severe',
            ],
            features: {
                areaRatio: { min: 0.5, max: 0.95 },
                topSpike: { min: 0.5, ideal: 0.8 },
            },
            weight: 1.3,
        },
        {
            id: 'bent_barrel',
            name: 'Bent Pump Barrel / Sticking Plunger',
            severity: 'caution',
            description: 'Plunger sticking or barrel bent — erratic load patterns, asymmetric card with humps.',
            operationalMeaning: 'Mechanical interference in pump. Barrel may be bent from installation or thermal effects.',
            actions: [
                'Pull and inspect pump',
                'Check for sand or scale buildup',
                'Verify tubing alignment',
            ],
            features: {
                symmetry: { max: 0.5 },
                areaRatio: { min: 0.3, max: 0.8 },
            },
            weight: 0.9,
        },
        {
            id: 'anchor_not_holding',
            name: 'Tubing Anchor Not Holding',
            severity: 'caution',
            description: 'Tubing moves with rod string because anchor is slipping. Card shifted or shows reduced net stroke due to tubing stretch.',
            operationalMeaning: 'Tubing anchor not gripping casing. Tubing reciprocates, absorbing pump stroke. Reduced production.',
            actions: [
                'Re-set tubing anchor',
                'Consider replacing anchor',
                'Check casing ID vs anchor size',
            ],
            features: {
                areaRatio: { min: 0.5, max: 0.85 },
                tubingMovement: { min: 0.3, ideal: 0.6 },
            },
            weight: 1.0,
        },
        {
            id: 'gas_lock',
            name: 'Gas Lock',
            severity: 'critical',
            description: 'Pump completely gas-locked — no fluid being pumped. Card collapses to a narrow sliver with almost no area.',
            operationalMeaning: 'Gas fills entire barrel. Neither valve can open because gas just compresses/expands. Zero production.',
            actions: [
                'Shut down and vent casing gas',
                'Install gas separator',
                'Lower pump below perfs',
                'Consider gas anchor modification',
            ],
            features: {
                areaRatio: { max: 0.15 },
                gasCompression: { min: 0.5 },
            },
            weight: 1.4,
        },
        {
            id: 'incomplete_fillage',
            name: 'Incomplete Pump Fillage',
            severity: 'info',
            description: 'Pump not fully filling each stroke — partial fluid pound. Less severe than full fluid pound.',
            operationalMeaning: 'Inflow rate slightly below pump displacement. Some gas or void space in barrel at start of upstroke.',
            actions: [
                'Consider slowing SPM slightly',
                'Monitor fluid level trend',
                'May be acceptable if production is near target',
            ],
            features: {
                areaRatio: { min: 0.55, ideal: 0.67, max: 0.82 },
                fluidPoundIdx: { min: 0.10, max: 0.35 },
                tvTransition: { min: 0.5 },
            },
            weight: 0.85,
        },
        {
            id: 'phase_shift',
            name: 'Phase Shift in Card',
            severity: 'info',
            description: 'Card appears rotated/shifted — usually a sensor timing or calibration issue, not a pump problem.',
            operationalMeaning: 'Position encoder timing may be off, or load cell calibration drifted. Card shape is valid but phased.',
            actions: [
                'Recalibrate position sensor',
                'Check encoder alignment',
                'May indicate kinematic correction needed',
            ],
            features: {
                areaRatio: { min: 0.5, max: 0.95 },
                phaseShift: { min: 0.3, ideal: 0.6 },
            },
            weight: 0.7,
        },
        // Level 1 merged conditions (displayed when L1 classifier fires)
        {
            id: 'under_filled',
            name: 'Incomplete Fillage',
            severity: 'warning',
            description: 'Pump barrel not completely filling each stroke. May be fluid pound (plunger hits liquid surface) or gas interference (gas mixed with fluid). A fluid level shot is needed to distinguish — card shape alone cannot reliably differentiate these two conditions (published: near-zero feature separation).',
            operationalMeaning: 'Pump displacement exceeds available fluid or gas is entering the barrel. Production is reduced. If fluid level is at pump intake → fluid pound. If fluid level is above pump → gas interference.',
            actions: [
                'Take fluid level shot to distinguish fluid pound vs gas interference',
                'If fluid pound: reduce SPM or lower pump',
                'If gas interference: check gas separator/anchor',
                'Monitor fillage trend over time',
            ],
            features: {},
            weight: 1.0,
        },
        {
            id: 'pump_issue',
            name: 'Pump Mechanical Issue',
            severity: 'caution',
            description: 'Card shape indicates a mechanical pump issue — could be incomplete fillage, worn pump barrel, or bent barrel/sticking plunger. These conditions are geometrically similar and difficult to distinguish from the card shape alone.',
            operationalMeaning: 'Pump is partially effective but has a mechanical issue reducing efficiency. May be progressive (worn barrel) or sudden (bent barrel).',
            actions: [
                'Compare with previous cards — is this new or progressive?',
                'Check for sand production (causes barrel wear)',
                'If efficiency declining: schedule pump replacement',
                'If sudden change: check for bent barrel or sticking',
            ],
            features: {},
            weight: 1.0,
        },
    ];

    // -----------------------------------------------------------------------
    // Feature Extraction
    // -----------------------------------------------------------------------

    /**
     * Extract shape features from a downhole card.
     *
     * @param {Array} position - Card position array (inches)
     * @param {Array} load     - Card load array (lbs)
     * @param {Object} rodModel - Optional rod model for reference values
     * @returns {Object} Feature vector
     */
    function extractFeatures(position, load, rodModel) {
        if (!position || !load || position.length < 10) return null;

        var N = Math.min(position.length, load.length);

        // Basic stats
        var minLoad = Infinity, maxLoad = -Infinity;
        var minPos = Infinity, maxPos = -Infinity;
        for (var i = 0; i < N; i++) {
            if (load[i] < minLoad) minLoad = load[i];
            if (load[i] > maxLoad) maxLoad = load[i];
            if (position[i] < minPos) minPos = position[i];
            if (position[i] > maxPos) maxPos = position[i];
        }

        var loadRange = maxLoad - minLoad;
        var posRange = maxPos - minPos;
        if (loadRange < 1 || posRange < 0.1) {
            return { areaRatio: 0, loadRange: 0, error: 'degenerate card' };
        }

        // Normalize to 0-1 range
        var normPos = [];
        var normLoad = [];
        for (var i = 0; i < N; i++) {
            normPos.push((position[i] - minPos) / posRange);
            normLoad.push((load[i] - minLoad) / loadRange);
        }

        // Card area (using shoelace formula on normalized card)
        var area = 0;
        for (var i = 0; i < N; i++) {
            var j = (i + 1) % N;
            area += normPos[i] * normLoad[j] - normPos[j] * normLoad[i];
        }
        area = Math.abs(area) / 2;
        var areaRatio = area;  // normalized area / 1.0 (ideal rectangle)

        // Find upstroke and downstroke segments
        // Upstroke: position increasing, Downstroke: position decreasing
        var upIndices = [];
        var downIndices = [];
        var midPos = 0.5;

        // Split card at approximate top and bottom of stroke
        var topIdx = 0, botIdx = 0;
        var topPos = 0, botPos = 1;
        for (var i = 0; i < N; i++) {
            if (normPos[i] > topPos) { topPos = normPos[i]; topIdx = i; }
            if (normPos[i] < botPos) { botPos = normPos[i]; botIdx = i; }
        }

        // Upstroke: from botIdx to topIdx (going forward, wrapping)
        for (var k = 0; k < N; k++) {
            var i = (botIdx + k) % N;
            upIndices.push(i);
            if (i === topIdx) break;
        }
        // Downstroke: from topIdx to botIdx
        for (var k = 0; k < N; k++) {
            var i = (topIdx + k) % N;
            downIndices.push(i);
            if (i === botIdx) break;
        }

        // Upstroke load slope (linear regression on upstroke load vs position)
        var upstrokeSlope = calcSlope(normPos, normLoad, upIndices);
        var downstrokeSlope = calcSlope(normPos, normLoad, downIndices);

        // Flat top: fraction of upstroke where load is within 15% of max upstroke load
        var maxUpLoad = 0;
        for (var k = 0; k < upIndices.length; k++) {
            if (normLoad[upIndices[k]] > maxUpLoad) maxUpLoad = normLoad[upIndices[k]];
        }
        var flatTopCount = 0;
        for (var k = 0; k < upIndices.length; k++) {
            if (normLoad[upIndices[k]] > maxUpLoad * 0.85) flatTopCount++;
        }
        var flatTop = upIndices.length > 0 ? flatTopCount / upIndices.length : 0;

        // Flat bottom: fraction of downstroke where load is within 15% of min downstroke load
        var minDownLoad = 1;
        for (var k = 0; k < downIndices.length; k++) {
            if (normLoad[downIndices[k]] < minDownLoad) minDownLoad = normLoad[downIndices[k]];
        }
        var flatBotCount = 0;
        for (var k = 0; k < downIndices.length; k++) {
            if (normLoad[downIndices[k]] < minDownLoad + 0.15) flatBotCount++;
        }
        var flatBottom = downIndices.length > 0 ? flatBotCount / downIndices.length : 0;

        // TV transition sharpness: how quickly load picks up at bottom of stroke
        var tvRegion = upIndices.slice(0, Math.max(3, Math.floor(upIndices.length * 0.15)));
        var tvTransition = 0;
        if (tvRegion.length > 1) {
            var loadJump = normLoad[tvRegion[tvRegion.length - 1]] - normLoad[tvRegion[0]];
            var posJump = normPos[tvRegion[tvRegion.length - 1]] - normPos[tvRegion[0]];
            tvTransition = posJump > 0.001 ? Math.min(1, loadJump / (posJump * 4)) : 0;
        }

        // SV transition sharpness: how quickly load drops at top of stroke
        var svRegion = downIndices.slice(0, Math.max(3, Math.floor(downIndices.length * 0.15)));
        var svTransition = 0;
        if (svRegion.length > 1) {
            var loadDrop = normLoad[svRegion[0]] - normLoad[svRegion[svRegion.length - 1]];
            var posDrop = normPos[svRegion[0]] - normPos[svRegion[svRegion.length - 1]];
            svTransition = Math.abs(posDrop) > 0.001 ? Math.min(1, loadDrop / (Math.abs(posDrop) * 4)) : 0;
        }

        // Fluid pound index: detect sharp load drop during downstroke
        var fluidPoundIdx = 0;
        if (downIndices.length > 5) {
            var maxDrop = 0;
            for (var k = 1; k < downIndices.length; k++) {
                var prevI = downIndices[k - 1];
                var curI = downIndices[k];
                var drop = normLoad[prevI] - normLoad[curI];
                if (drop > maxDrop) maxDrop = drop;
            }
            fluidPoundIdx = Math.min(1, maxDrop * 3);
        }

        // Gas compression: gradual load buildup (vs sharp TV transition)
        var gasCompression = Math.max(0, 1 - tvTransition);

        // Symmetry: compare first half vs second half shape
        var halfN = Math.floor(N / 2);
        var symDiff = 0;
        for (var i = 0; i < halfN; i++) {
            var mirrorI = N - 1 - i;
            symDiff += Math.abs(normLoad[i] - normLoad[mirrorI]);
        }
        var symmetry = halfN > 0 ? 1 - Math.min(1, symDiff / halfN) : 0.5;

        // Load range ratio (vs expected fluid load)
        var loadRangeRatio = 1.0;
        if (rodModel) {
            var plungerArea = Math.PI * rodModel.plungerDiam * rodModel.plungerDiam / 4;
            var expectedFluidLoad = rodModel.fluidSG * 0.433 * (rodModel.pumpDepth / 12) * plungerArea;
            if (expectedFluidLoad > 0) {
                loadRangeRatio = loadRange / expectedFluidLoad;
            }
        }

        // Bottom spike (pump hitting down)
        var bottomSpike = 0;
        var bottomRegion = upIndices.slice(0, Math.max(3, Math.floor(upIndices.length * 0.1)));
        if (bottomRegion.length > 1) {
            var spikeLoad = 0;
            for (var k = 0; k < bottomRegion.length; k++) {
                if (normLoad[bottomRegion[k]] > spikeLoad) spikeLoad = normLoad[bottomRegion[k]];
            }
            var avgUpLoad = 0;
            for (var k = 0; k < upIndices.length; k++) avgUpLoad += normLoad[upIndices[k]];
            avgUpLoad /= upIndices.length;
            if (spikeLoad > avgUpLoad * 1.3) bottomSpike = Math.min(1, (spikeLoad - avgUpLoad) * 3);
        }

        // Top spike (pump hitting up)
        var topSpike = 0;
        var topRegion = downIndices.slice(0, Math.max(3, Math.floor(downIndices.length * 0.1)));
        if (topRegion.length > 1) {
            var topSpikeLoad = 1;
            for (var k = 0; k < topRegion.length; k++) {
                if (normLoad[topRegion[k]] < topSpikeLoad) topSpikeLoad = normLoad[topRegion[k]];
            }
            var avgDownLoad = 0;
            for (var k = 0; k < downIndices.length; k++) avgDownLoad += normLoad[downIndices[k]];
            avgDownLoad /= downIndices.length;
            if (topSpikeLoad < avgDownLoad * 0.7) topSpike = Math.min(1, (avgDownLoad - topSpikeLoad) * 3);
        }

        // Tubing movement: difference in position at same load levels
        var tubingMovement = 0;
        // Compare position at mid-load during upstroke vs downstroke
        var midLoadLevel = 0.5;
        var upMidPos = interpPosAtLoad(normPos, normLoad, upIndices, midLoadLevel);
        var downMidPos = interpPosAtLoad(normPos, normLoad, downIndices, midLoadLevel);
        if (upMidPos !== null && downMidPos !== null) {
            tubingMovement = Math.abs(upMidPos - downMidPos);
        }

        // Phase shift: detect if card is rotated from expected orientation
        var phaseShift = 0;
        // If max load occurs far from bottom of stroke or min load far from top
        var maxLoadPos = normPos[0];
        for (var i = 1; i < N; i++) {
            if (normLoad[i] === maxLoad) maxLoadPos = normPos[i];
        }
        if (maxLoadPos > 0.6 || maxLoadPos < 0.1) phaseShift = 0.5;

        // C-to-D transition sharpness (sharp = full pump/fluid pound, gradual = gas interference)
        // Uses AVERAGE slope over the first 30% of downstroke (not max, which saturates).
        // Published criterion: gas interference has gradual/rounded C-D (avg < 3),
        // fluid pound has sharp C-D (avg > 3), full pump has very sharp (avg > 8).
        var cdSharpness = 0;
        if (downIndices.length > 5) {
            var cdSeg = downIndices.slice(0, Math.max(5, Math.floor(downIndices.length * 3 / 10)));
            var cdSum = 0, cdCount = 0;
            for (var k = 1; k < cdSeg.length; k++) {
                var cdDP = Math.abs(normPos[cdSeg[k]] - normPos[cdSeg[k - 1]]);
                var cdDL = normLoad[cdSeg[k - 1]] - normLoad[cdSeg[k]];
                if (cdDP > 0.001) {
                    cdSum += cdDL / cdDP;
                    cdCount++;
                }
            }
            if (cdCount > 0) cdSharpness = Math.min(1, (cdSum / cdCount) / 15.0);
        }

        // A-to-B transition sharpness (sharp = normal/full pump, gradual = gas/TV leak)
        // Same avg slope approach, normalized to 0-1 range (÷15).
        var abSharpness = 0;
        if (upIndices.length > 5) {
            var abSeg = upIndices.slice(0, Math.max(5, Math.floor(upIndices.length * 3 / 10)));
            var abSum = 0, abCount = 0;
            for (var k = 1; k < abSeg.length; k++) {
                var abDP = Math.abs(normPos[abSeg[k]] - normPos[abSeg[k - 1]]);
                var abDL = normLoad[abSeg[k]] - normLoad[abSeg[k - 1]];
                if (abDP > 0.001) {
                    abSum += abDL / abDP;
                    abCount++;
                }
            }
            if (abCount > 0) abSharpness = Math.min(1, (abSum / abCount) / 15.0);
        }

        // Max single-step slope at C-D and A-B transitions (normalized).
        // This captures "impact" vs "gradual" transitions better than avg slope.
        // Published: gas interference has low max (gradual), fluid pound has high
        // max (plunger impact on liquid surface), full pump has very high max.
        // Normalized by dividing by 50 (typical max range for strong impacts).
        var cdMaxSlope = 0;
        if (downIndices.length > 5) {
            var cdSeg2 = downIndices.slice(0, Math.max(5, Math.floor(downIndices.length * 3 / 10)));
            for (var k = 1; k < cdSeg2.length; k++) {
                var dp2 = Math.abs(normPos[cdSeg2[k]] - normPos[cdSeg2[k - 1]]);
                if (dp2 > 0.001) {
                    var sl = (normLoad[cdSeg2[k - 1]] - normLoad[cdSeg2[k]]) / dp2;
                    if (sl > cdMaxSlope) cdMaxSlope = sl;
                }
            }
            cdMaxSlope = Math.min(1, cdMaxSlope / 50.0);
        }

        var abMaxSlope = 0;
        if (upIndices.length > 5) {
            var abSeg2 = upIndices.slice(0, Math.max(5, Math.floor(upIndices.length * 3 / 10)));
            for (var k = 1; k < abSeg2.length; k++) {
                var dp2 = Math.abs(normPos[abSeg2[k]] - normPos[abSeg2[k - 1]]);
                if (dp2 > 0.001) {
                    var sl = (normLoad[abSeg2[k]] - normLoad[abSeg2[k - 1]]) / dp2;
                    if (sl > abMaxSlope) abMaxSlope = sl;
                }
            }
            abMaxSlope = Math.min(1, abMaxSlope / 50.0);
        }

        // Downstroke load elevation (mean mid-downstroke load, normalized)
        // High = SV leak (downstroke load elevated above zero line)
        var dnLoadElev = 0;
        if (downIndices.length > 4) {
            var midDnStart = Math.floor(downIndices.length / 4);
            var midDnEnd = Math.floor(3 * downIndices.length / 4);
            var dnSum = 0, dnCount = 0;
            for (var k = midDnStart; k < midDnEnd; k++) {
                dnSum += normLoad[downIndices[k]];
                dnCount++;
            }
            if (dnCount > 0) dnLoadElev = dnSum / dnCount;
        }

        // Upstroke load drop point (fraction of upstroke before load drops below 80% of max)
        // Late = full pump, early = fluid pound / incomplete fillage
        var upDropPt = 1.0;
        if (upIndices.length > 5) {
            var upMaxLoad = 0;
            for (var k = 0; k < upIndices.length; k++) {
                if (normLoad[upIndices[k]] > upMaxLoad) upMaxLoad = normLoad[upIndices[k]];
            }
            var dropThresh = upMaxLoad * 0.80;
            for (var k = Math.floor(upIndices.length / 4); k < upIndices.length; k++) {
                if (normLoad[upIndices[k]] < dropThresh) {
                    upDropPt = k / upIndices.length;
                    break;
                }
            }
        }

        // Max downstroke load drop LOCATION (0=start of downstroke, 1=end)
        // Published: fluid pound impact occurs MID-downstroke (plunger travels through
        // gas void then hits liquid). Full pump/incomplete fillage drop early (C-D transition).
        var maxDropLoc = 0;
        if (downIndices.length > 5) {
            var bestDrop = 0;
            for (var k = 1; k < downIndices.length; k++) {
                var kDrop = normLoad[downIndices[k - 1]] - normLoad[downIndices[k]];
                if (kDrop > bestDrop) {
                    bestDrop = kDrop;
                    maxDropLoc = k / downIndices.length;
                }
            }
        }

        // Downstroke convexity: is the load profile convex (gas compression) or concave?
        // Convex (positive) = load stays high mid-downstroke before dropping → gas in barrel
        // Concave (negative) = normal rapid drop at C-D
        // Published: gas interference shows gradual compression → convex downstroke profile
        var dnConvexity = 0;
        if (downIndices.length > 9) {
            var dnThird = Math.max(1, Math.floor(downIndices.length / 3));
            var earlyAvg = 0, midAvg = 0, lateAvg = 0;
            for (var k = 0; k < dnThird; k++) earlyAvg += normLoad[downIndices[k]];
            earlyAvg /= dnThird;
            for (var k = dnThird; k < 2 * dnThird; k++) midAvg += normLoad[downIndices[k]];
            midAvg /= dnThird;
            for (var k = 2 * dnThird; k < downIndices.length; k++) lateAvg += normLoad[downIndices[k]];
            lateAvg /= (downIndices.length - 2 * dnThird);
            dnConvexity = midAvg - (earlyAvg + lateAvg) / 2;
        }

        // Early downstroke load (first third average, normalized)
        // High = gas compression holding load up; Low = rapid valve opening
        var earlyDnLoad = 0;
        if (downIndices.length > 6) {
            var eThird = Math.max(1, Math.floor(downIndices.length / 3));
            var eSum = 0;
            for (var k = 0; k < eThird; k++) eSum += normLoad[downIndices[k]];
            earlyDnLoad = eSum / eThird;
        }

        // Downstroke smoothness: std of load differences where position decreases
        // Uses sequential scan (not formal downstroke segment) — captures all
        // decreasing-position load behavior including reversals.
        // High = rough/irregular (under_filled, rod issues), Low = smooth (full pump)
        var dsSmooth = 0;
        var dsLoads = [];
        for (var i = 1; i < N; i++) {
            if (normPos[i] < normPos[i - 1]) {
                dsLoads.push(normLoad[i]);
            }
        }
        if (dsLoads.length > 3) {
            var dsDiffs = [];
            for (var k = 0; k < dsLoads.length - 1; k++) {
                dsDiffs.push(dsLoads[k + 1] - dsLoads[k]);
            }
            var dsMean = 0;
            for (var k = 0; k < dsDiffs.length; k++) dsMean += dsDiffs[k];
            dsMean /= dsDiffs.length;
            var dsVar = 0;
            for (var k = 0; k < dsDiffs.length; k++) {
                var dd = dsDiffs[k] - dsMean;
                dsVar += dd * dd;
            }
            dsSmooth = Math.sqrt(dsVar / dsDiffs.length);
        }

        return {
            areaRatio: areaRatio,
            loadRange: loadRangeRatio,
            upstrokeSlope: upstrokeSlope,
            downstrokeSlope: downstrokeSlope,
            tvTransition: tvTransition,
            svTransition: svTransition,
            flatTop: flatTop,
            flatBottom: flatBottom,
            fluidPoundIdx: fluidPoundIdx,
            gasCompression: gasCompression,
            symmetry: symmetry,
            bottomSpike: bottomSpike,
            topSpike: topSpike,
            tubingMovement: tubingMovement,
            phaseShift: phaseShift,
            cdSharpness: cdSharpness,
            abSharpness: abSharpness,
            cdMaxSlope: cdMaxSlope,
            abMaxSlope: abMaxSlope,
            dnLoadElev: dnLoadElev,
            upDropPt: upDropPt,
            maxDropLoc: maxDropLoc,
            dnConvexity: dnConvexity,
            earlyDnLoad: earlyDnLoad,
            dsSmooth: dsSmooth,
            // Raw stats for display
            _minLoad: minLoad,
            _maxLoad: maxLoad,
            _minPos: minPos,
            _maxPos: maxPos,
            _loadRange: loadRange,
            _posRange: posRange,
            _cardArea: area,
        };
    }

    /**
     * Extract features from SURFACE card for S-type card diagnosis.
     * Surface cards are always available and reliable. Uses different
     * feature set than downhole cards — surface card shapes encode pump
     * condition through rod string dynamics.
     *
     * Returns L1 class estimate with confidence, or null if can't determine.
     */
    function diagnoseSurfaceCard(position, load) {
        if (!position || !load || position.length < 10) return null;
        var N = Math.min(position.length, load.length);

        var minL = Infinity, maxL = -Infinity, minP = Infinity, maxP = -Infinity;
        for (var i = 0; i < N; i++) {
            if (load[i] < minL) minL = load[i];
            if (load[i] > maxL) maxL = load[i];
            if (position[i] < minP) minP = position[i];
            if (position[i] > maxP) maxP = position[i];
        }
        var lr = maxL - minL, pr = maxP - minP;
        if (lr < 1 || pr < 0.1) return null;

        var nP = [], nL = [];
        for (var i = 0; i < N; i++) {
            nP.push((position[i] - minP) / pr);
            nL.push((load[i] - minL) / lr);
        }

        // Area
        var area = 0;
        for (var i = 0; i < N; i++) {
            var j = (i + 1) % N;
            area += nP[i] * nL[j] - nP[j] * nL[i];
        }
        area = Math.abs(area) / 2;

        // Find stroke top/bottom
        var topI = 0, botI = 0;
        for (var i = 1; i < N; i++) {
            if (nP[i] > nP[topI]) topI = i;
            if (nP[i] < nP[botI]) botI = i;
        }
        var upI = [], dnI = [];
        for (var k = 0; k < N; k++) {
            var idx = (botI + k) % N;
            upI.push(idx);
            if (idx === topI) break;
        }
        for (var k = 0; k < N; k++) {
            var idx = (topI + k) % N;
            dnI.push(idx);
            if (idx === botI) break;
        }

        // Mid-upstroke slope
        var upSlope = 0;
        if (upI.length > 6) {
            var s = Math.floor(upI.length / 4), e = Math.floor(3 * upI.length / 4);
            upSlope = calcSlope(nP, nL, upI.slice(s, e));
        }

        // Mean load level
        var meanLoad = 0;
        for (var i = 0; i < N; i++) meanLoad += nL[i];
        meanLoad /= N;

        // Simple surface card classification based on empirical separations:
        // under_filled: area < 0.46, upSlope > 0 (rising upstroke)
        // full_pump: area ~0.50, upSlope < 0 (declining upstroke)
        // sv_leak: area > 0.52, meanLoad < 0.44
        // pump_issue: area > 0.48, widthVar high
        var result = { condition: 'unknown', confidence: 0.25, evidence: '' };

        if (area < 0.42 && upSlope > 0.05) {
            result = { condition: 'under_filled', confidence: 0.55,
                evidence: 'Surface card: small area (' + (area * 100).toFixed(0) + '%), rising upstroke (slope=' + upSlope.toFixed(2) + '). Pump not filling completely.' };
        } else if (area > 0.47 && upSlope < -0.10 && meanLoad > 0.46) {
            result = { condition: 'full_pump', confidence: 0.50,
                evidence: 'Surface card: large area (' + (area * 100).toFixed(0) + '%), declining upstroke (slope=' + upSlope.toFixed(2) + '). Consistent with full pump.' };
        } else if (area > 0.52 && meanLoad < 0.44) {
            result = { condition: 'sv_leak', confidence: 0.40,
                evidence: 'Surface card: large area (' + (area * 100).toFixed(0) + '%), low mean load (' + (meanLoad * 100).toFixed(0) + '%). Possible SV leak.' };
        } else if (area > 0.46) {
            result = { condition: 'pump_issue', confidence: 0.35,
                evidence: 'Surface card: area ' + (area * 100).toFixed(0) + '%, upSlope=' + upSlope.toFixed(2) + '. Possible mechanical issue or incomplete fillage.' };
        } else {
            result = { condition: 'under_filled', confidence: 0.30,
                evidence: 'Surface card: reduced area (' + (area * 100).toFixed(0) + '%). Pump likely not filling completely.' };
        }

        return result;
    }

    function calcSlope(xArr, yArr, indices) {
        if (indices.length < 3) return 0;
        var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        var n = indices.length;
        for (var k = 0; k < n; k++) {
            var x = xArr[indices[k]];
            var y = yArr[indices[k]];
            sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
        }
        var denom = n * sumX2 - sumX * sumX;
        if (Math.abs(denom) < 1e-10) return 0;
        return (n * sumXY - sumX * sumY) / denom;
    }

    function interpPosAtLoad(normPos, normLoad, indices, targetLoad) {
        for (var k = 1; k < indices.length; k++) {
            var prev = indices[k - 1], cur = indices[k];
            var l0 = normLoad[prev], l1 = normLoad[cur];
            if ((l0 <= targetLoad && l1 >= targetLoad) || (l0 >= targetLoad && l1 <= targetLoad)) {
                if (Math.abs(l1 - l0) < 1e-10) return normPos[prev];
                var frac = (targetLoad - l0) / (l1 - l0);
                return normPos[prev] + frac * (normPos[cur] - normPos[prev]);
            }
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // kNN Classifier
    // -----------------------------------------------------------------------

    /**
     * kNN classifier (k=3, distance-weighted, standardized features).
     * Uses 12 features (drops flatBottom and upDropPt, adds dsSmooth).
     * Trained on 55 XSPOC-classified wells. 70% 6-class LOO-CV accuracy.
     *
     * @param {Array} fVec - 14-element feature vector from extractFeatures
     * @returns {Object} { label, confidence, neighbors }
     */
    function classifyKNN(fVec) {
        var nf = KNN_KEEP.length;
        var k = 3;
        // Standardize query using precomputed mean/std
        var q = new Array(nf);
        for (var fi = 0; fi < nf; fi++) {
            q[fi] = (fVec[KNN_KEEP[fi]] - KNN_MEAN[fi]) / KNN_STDDEV[fi];
        }
        // Compute distances to all training points
        var dists = new Array(KNN_STD_DATA.length);
        for (var i = 0; i < KNN_STD_DATA.length; i++) {
            var t = KNN_STD_DATA[i];
            var dist = 0;
            for (var fi = 0; fi < nf; fi++) {
                var d = q[fi] - t.vec[fi];
                dist += d * d;
            }
            dists[i] = { dist: Math.sqrt(dist), label: t.label };
        }
        // Sort by distance
        dists.sort(function (a, b) { return a.dist - b.dist; });
        // Distance-weighted voting
        var votes = {};
        var totalWeight = 0;
        for (var i = 0; i < k && i < dists.length; i++) {
            var w = 1.0 / (dists[i].dist + 0.01);
            votes[dists[i].label] = (votes[dists[i].label] || 0) + w;
            totalWeight += w;
        }
        // Find winner
        var bestLabel = null, bestVote = -1;
        for (var label in votes) {
            if (votes.hasOwnProperty(label) && votes[label] > bestVote) {
                bestVote = votes[label];
                bestLabel = label;
            }
        }
        var confidence = totalWeight > 0 ? bestVote / totalWeight : 0;
        return { label: bestLabel, confidence: confidence, neighbors: dists.slice(0, k) };
    }

    // -----------------------------------------------------------------------
    // Pattern Matching
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Empirical Centroids — fleet-retrained from 56 wells (2026-04-10)
    //
    // Each centroid is [areaRatio, flatTop, flatBottom, fluidPoundIdx,
    //   svTransition, tvTransition, cdSharpness, abSharpness, dnLoadElev, upDropPt]
    // with corresponding standard deviations. Used by the nearest-centroid
    // classifier to score each pattern.
    //
    // New features from published diagnostic criteria:
    //   cdSharpness: C-to-D transition slope (sharp=fluid pound, gradual=gas)
    //   abSharpness: A-to-B transition slope (sharp=normal, gradual=TV leak/gas)
    //   dnLoadElev:  mean mid-downstroke load (high=SV leak)
    //   upDropPt:    fraction of upstroke before load drops (late=full pump)
    // -----------------------------------------------------------------------
    // Two-level centroid classifier trained on 14,789 XSPOC-classified cards.
    // Level 1: 6 broad classes (54% on 15K cards). Merges geometrically
    // indistinguishable conditions: Worn pump/Bent barrel/Incomplete fillage
    // → "Pump issue"; Fluid pound/Gas interference → "Under-filled".
    // Level 2: sub-classifies within merged groups.
    //
    // CENTROIDS is the Level 1 set used by diagnose().
    // L2_CENTROIDS provides sub-classification shown as secondary diagnosis.
    // L2 sub-classification centroids (13-feature vectors, retrained 2026-03-26)
    // Features: [ar, ft, fb, fp, sv, tv, cd, ab, dnE, upD, maxDropLoc, dnConv, earlyDn]
    var L2_CENTROIDS = {
        fluid_pound:        { mean: [0.657, 0.666, 0.505, 0.208, 0.438, 0.841, 0.302, 0.554, 0.205, 0.648, 0.293, -0.245, 0.692], std: [0.115, 0.231, 0.163, 0.075, 0.424, 0.276, 0.284, 0.318, 0.150, 0.347, 0.125, 0.162, 0.211], n: 1550, group: 'under_filled' },
        gas_interference:   { mean: [0.666, 0.717, 0.529, 0.181, 0.511, 0.606, 0.220, 0.365, 0.163, 0.738, 0.223, -0.293, 0.658], std: [0.154, 0.247, 0.127, 0.041, 0.679, 0.378, 0.198, 0.391, 0.109, 0.357, 0.140, 0.111, 0.192], n: 289, group: 'under_filled' },
        incomplete_fillage: { mean: [0.777, 0.709, 0.558, 0.181, 0.096, 0.937, 0.613, 0.645, 0.131, 0.677, 0.220, -0.261, 0.642], std: [0.069, 0.153, 0.118, 0.061, 1.444, 0.144, 0.283, 0.241, 0.045, 0.367, 0.086, 0.080, 0.147], n: 2034, group: 'pump_issue' },
        worn_pump:          { mean: [0.730, 0.754, 0.591, 0.202, 0.705, 0.718, 0.610, 0.527, 0.107, 0.852, 0.241, -0.243, 0.466], std: [0.140, 0.203, 0.121, 0.082, 0.397, 0.546, 0.422, 0.377, 0.055, 0.250, 0.232, 0.106, 0.216], n: 141, group: 'pump_issue' },
        bent_barrel:        { mean: [0.768, 0.739, 0.527, 0.212, 0.732, 0.930, 0.430, 0.667, 0.126, 0.918, 0.136, -0.091, 0.274], std: [0.033, 0.125, 0.183, 0.050, 0.253, 0.189, 0.370, 0.263, 0.033, 0.097, 0.132, 0.091, 0.114], n: 458, group: 'pump_issue' },
    };
    // L1 broad-class centroids — fleet-retrained from 56 XSPOC-classified wells
    // Used as fallback reference. Primary classifier is kNN (see KNN_TRAINING below).
    // Updated 2026-04-10.
    var CENTROIDS = {
        full_pump:    { mean: [0.823,0.645,0.757,0.141,-2.481,1.000,0.506,0.770,0.063,0.872,0.138,-0.164,0.341], std: [0.071,0.180,0.128,0.050,8.217,0.050,0.337,0.211,0.050,0.163,0.092,0.108,0.232], n: 7 },
        pump_issue:   { mean: [0.743,0.617,0.715,0.162,0.906,0.914,0.459,0.636,0.073,0.785,0.130,-0.097,0.253], std: [0.208,0.236,0.183,0.050,0.229,0.211,0.347,0.316,0.050,0.275,0.110,0.061,0.149], n: 7 },
        rod_part:     { mean: [0.446,0.179,0.155,0.119,-0.227,-0.146,0.026,0.001,0.481,0.266,0.626,-0.034,0.692], std: [0.115,0.138,0.092,0.075,0.484,0.656,0.071,0.099,0.253,0.050,0.322,0.114,0.259], n: 4 },
        sv_leak:      { mean: [0.717,0.576,0.511,0.163,0.525,0.459,0.214,0.205,0.126,0.601,0.098,-0.173,0.246], std: [0.112,0.151,0.220,0.098,0.418,0.487,0.354,0.283,0.091,0.242,0.066,0.055,0.153], n: 7 },
        tv_leak:      { mean: [0.748,0.426,0.761,0.062,0.435,0.833,0.108,0.260,0.069,0.552,0.131,-0.086,0.123], std: [0.121,0.079,0.282,0.050,0.431,0.373,0.108,0.131,0.083,0.217,0.100,0.086,0.083], n: 6 },
        under_filled: { mean: [0.641,0.607,0.469,0.215,0.467,0.714,0.376,0.441,0.208,0.613,0.301,-0.212,0.610], std: [0.215,0.253,0.181,0.089,0.625,0.386,0.361,0.319,0.180,0.343,0.208,0.169,0.210], n: 25 },
    };

    // -----------------------------------------------------------------------
    // kNN Training Data — 55 XSPOC-classified wells (latest N-type DH card)
    // -----------------------------------------------------------------------
    // Format: [label_idx, aR, fT, fB, fP, sv, tv, cd, ab, dnE, upD, mdl, dnC, edl, dsSmooth]
    // Labels: 0=full_pump, 1=under_filled, 2=pump_issue, 3=sv_leak, 4=tv_leak, 5=rod_part
    // kNN k=3 distance-weighted, dropping flatBottom(2) and upDropPt(9), adding dsSmooth(13)
    // No physics overrides. 70% 6-class LOO-CV accuracy.
    var KNN_TRAINING = [
        [0,0.6586,0.2269,0.8795,0.1292,1.0000,1.0000,0.4556,1.0000,0.0811,0.4958,0.0964,-0.0831,0.1863,0.0680],
        [0,0.8566,0.6102,0.9881,0.0934,0.2280,1.0000,0.0816,0.5071,0.0529,0.8475,0.0119,-0.0105,0.0869,0.0040],
        [0,0.8856,0.7500,0.7551,0.1311,1.0000,1.0000,0.6807,0.5039,0.0285,0.9231,0.0816,-0.1361,0.2219,0.0344],
        [0,0.8293,0.7222,0.5789,0.1600,1.0000,1.0000,0.5338,0.6859,0.0690,0.8750,0.0877,-0.1317,0.2108,0.0318],
        [0,0.7603,0.7000,0.3654,0.2459,1.0000,1.0000,1.0000,0.8372,0.1472,1.0000,0.1731,-0.1947,0.5101,0.0928],
        [0,0.8768,0.6860,0.6552,0.1921,-22.5980,1.0000,0.0000,1.0000,0.1179,1.0000,0.3103,-0.3644,0.8043,0.0310],
        [1,0.4732,0.5300,0.5392,0.1100,-0.1339,-0.2975,0.1428,0.0060,0.3165,0.2500,0.4216,-0.2153,0.8348,0.0122],
        [1,0.7739,0.6701,0.6190,0.1480,-1.5285,-0.0273,0.0693,0.2858,0.1468,0.2474,0.3429,-0.3628,0.8350,0.0252],
        [1,0.6601,0.9886,0.4474,0.1886,0.2803,0.4207,0.0617,0.1321,0.1877,1.0000,0.3246,-0.4294,0.7908,0.0309],
        [1,0.7948,0.6444,0.7193,0.2879,1.0000,1.0000,0.8206,0.8302,0.0368,0.4667,0.1754,-0.2163,0.3967,0.0706],
        [1,0.7261,0.5200,0.5385,0.3116,1.0000,0.2186,1.0000,0.0670,0.0758,0.4000,0.0769,-0.2666,0.4273,0.0510],
        [1,0.7166,0.5631,0.4747,0.1076,1.0000,1.0000,0.3517,0.3437,0.1088,0.8155,0.2323,-0.2636,0.5033,0.0715],
        [1,0.6662,0.9773,0.2759,0.4225,0.1896,1.0000,0.0530,0.3056,0.2353,1.0000,0.3103,-0.4638,0.8687,0.0654],
        [1,0.7873,0.8679,0.3061,0.1721,0.8958,0.5537,0.4032,0.0787,0.1247,0.9057,0.0204,-0.1541,0.2286,0.0776],
        [1,0.8389,0.7500,0.5943,0.1966,1.0000,1.0000,0.6365,1.0000,0.0948,1.0000,0.2264,-0.3241,0.6363,0.0621],
        [1,0.2270,0.6438,0.1395,0.2721,0.0954,1.0000,0.0603,0.5324,0.6765,0.2466,0.7519,0.1203,0.8700,0.0894],
        [1,0.5139,0.6139,0.2871,0.1891,-0.1367,0.1407,0.0672,0.1595,0.6825,0.2475,0.6634,0.2515,0.9483,0.0747],
        [1,0.7662,0.8293,0.5917,0.1521,1.0000,0.7865,0.3331,0.0992,0.0547,1.0000,0.0583,-0.2836,0.3829,0.0431],
        [1,0.5395,0.2115,0.2203,0.1389,-0.2560,0.1916,0.1160,0.4827,0.1829,0.2500,0.3729,-0.2970,0.5100,0.0279],
        [1,0.0108,0.0851,0.2727,0.1204,0.3353,1.0000,0.0312,0.2657,0.5721,0.2340,0.7091,0.1259,0.5543,0.0299],
        [1,0.6000,0.8600,0.2692,0.4484,-0.0610,1.0000,-0.0143,0.5300,0.2806,1.0000,0.3654,-0.3516,0.9195,0.0851],
        [1,0.5812,0.7053,0.5234,0.1552,-0.0344,0.6754,0.1233,0.3297,0.2426,0.2421,0.3364,-0.2774,0.8860,0.0965],
        [1,0.8338,0.8602,0.6789,0.1420,1.0000,1.0000,0.8874,0.8421,0.0705,1.0000,0.2294,-0.2306,0.5366,0.0718],
        [1,0.7991,0.7647,0.6800,0.1462,1.0000,1.0000,0.9844,0.9516,0.0892,1.0000,0.1400,-0.1854,0.4923,0.0956],
        [1,0.6870,0.3077,0.5079,0.2659,0.7511,0.4921,0.2141,0.1169,0.1316,0.2308,0.2540,-0.3946,0.6633,0.0512],
        [1,0.1624,0.0577,0.1400,0.2531,-0.1072,0.7222,0.0219,0.0285,0.3348,0.2500,0.7200,-0.1015,0.5643,0.0403],
        [1,0.7902,0.5500,0.5476,0.1738,1.0000,1.0000,0.2436,0.7050,0.1103,0.8000,0.0238,-0.0352,0.1415,0.0668],
        [1,0.6741,0.2150,0.5789,0.1760,0.3792,1.0000,0.1594,0.8791,0.1311,0.4860,0.2842,-0.2460,0.5989,0.0190],
        [2,0.7906,0.6909,0.6170,0.2568,1.0000,1.0000,0.1144,0.9825,0.1154,0.9091,0.0213,-0.0144,0.1765,0.0325],
        [2,0.8223,0.7129,0.7525,0.1099,1.0000,1.0000,1.0000,0.7085,0.0510,0.9604,0.1386,-0.1453,0.3236,0.0492],
        [2,0.8283,0.6981,0.7500,0.1106,1.0000,1.0000,0.7902,0.6960,0.0337,0.9623,0.1667,-0.1568,0.3308,0.0531],
        [2,0.2345,0.0741,0.5208,0.1638,1.0000,0.3957,0.0730,-0.0189,0.1057,0.2407,0.3542,-0.1308,0.1937,0.0438],
        [2,0.7362,0.5733,0.4302,0.1157,-0.0150,0.2324,0.0725,0.0638,0.2014,0.6800,0.0116,-0.1871,0.0980,0.0925],
        [2,0.8405,0.5556,1.0000,0.1756,0.3452,1.0000,0.0943,1.0000,0.0287,0.4921,0.0256,-0.0194,0.0431,0.0109],
        [2,0.8518,0.8500,0.7059,0.1741,1.0000,1.0000,1.0000,1.0000,0.0456,1.0000,0.2157,-0.2634,0.5474,0.0193],
        [2,0.8311,0.7600,0.7875,0.1415,1.0000,1.0000,0.7905,0.7013,0.0372,0.9900,0.1625,-0.1363,0.3530,0.0900],
        [2,0.8305,0.8144,0.4667,0.1412,1.0000,1.0000,0.7528,0.6318,0.1230,1.0000,0.1714,-0.1653,0.5204,0.0145],
        [3,0.8039,0.7647,0.5686,0.2610,1.0000,1.0000,0.4271,0.4243,0.0709,0.4510,0.0980,-0.2305,0.3904,0.0523],
        [3,0.6792,0.6327,0.5849,0.1196,0.1260,-0.1460,0.0979,-0.1295,0.1089,0.8367,0.2075,-0.1961,0.0942,0.1261],
        [3,0.7735,0.4800,0.4608,0.0494,0.0962,-0.0081,0.0301,0.0187,0.0805,0.5600,0.0098,-0.2502,0.1465,0.0766],
        [3,0.8146,0.4361,0.8696,0.0185,0.1126,1.0000,0.0196,0.3477,0.0372,0.7143,0.0145,-0.0820,0.0985,0.0610],
        [3,0.8097,0.8182,0.5825,0.1810,1.0000,1.0000,1.0000,0.7310,0.1153,1.0000,0.1553,-0.1594,0.5081,0.0172],
        [3,0.4837,0.4685,0.0769,0.3044,1.0000,0.0335,-0.0540,0.0359,0.3361,0.2973,0.0879,-0.1195,0.3399,0.0380],
        [3,0.6549,0.4310,0.4318,0.2073,0.3403,0.3347,-0.0225,0.0060,0.1357,0.3448,0.1136,-0.1727,0.1458,0.0759],
        [4,0.8002,0.3381,1.0000,0.0364,0.2967,1.0000,0.0553,0.3155,0.0170,0.2446,0.0159,-0.0300,0.0059,0.0140],
        [4,0.7078,0.4371,1.0000,0.0383,0.0646,1.0000,-0.0049,0.3210,0.0406,0.6821,0.1765,-0.0039,0.0926,0.1092],
        [4,0.8124,0.4452,0.8036,0.0429,0.3718,1.0000,0.0778,0.3123,0.0524,0.2466,0.1964,-0.0464,0.1670,0.0410],
        [4,0.8264,0.5591,0.7200,0.0737,1.0000,1.0000,0.1460,0.2178,0.0257,0.7244,0.0133,-0.1257,0.0880,0.0093],
        [4,0.8465,0.4526,0.8727,0.0905,1.0000,1.0000,0.3271,0.3987,0.0239,0.7263,0.0909,-0.0499,0.1077,0.0189],
        [4,0.8434,0.6518,0.9111,0.1435,1.0000,1.0000,0.4341,0.5259,0.0401,0.8929,0.0333,-0.0530,0.1406,0.0354],
        [4,0.4949,0.3211,0.1720,0.0924,-0.1259,0.0000,0.0478,-0.0080,0.2531,0.6881,0.2903,-0.2589,0.2758,0.0553],
        [5,0.3142,0.1031,0.0857,0.0596,-0.8273,-0.7971,-0.0728,-0.0455,0.7879,0.2474,0.9333,0.1422,0.9402,0.0078],
        [5,0.3542,0.0825,0.0571,0.1015,-0.5713,-0.2416,0.0010,-0.0141,0.6687,0.2474,0.9429,-0.0111,0.8960,0.0135],
        [5,0.5864,0.4167,0.2925,0.0696,0.1751,0.9385,0.0542,0.1639,0.2834,0.2500,0.4245,-0.1234,0.6429,0.0313],
        [5,0.5303,0.1132,0.1837,0.2471,0.3175,-0.4828,0.1199,-0.1014,0.1839,0.3208,0.2041,-0.1449,0.2897,0.0482],
    ];
    var KNN_LABELS = ['full_pump','under_filled','pump_issue','sv_leak','tv_leak','rod_part'];
    // Feature indices to keep for kNN (dropping flatBottom=2, upDropPt=9; adding dsSmooth=13)
    var KNN_KEEP = [0,1,3,4,5,6,7,8,10,11,12,13];

    // Precompute standardization params and standardized training data
    var KNN_MEAN, KNN_STDDEV, KNN_STD_DATA;
    (function () {
        var n = KNN_TRAINING.length, nf = KNN_KEEP.length;
        KNN_MEAN = new Array(nf);
        KNN_STDDEV = new Array(nf);
        for (var fi = 0; fi < nf; fi++) {
            var idx = KNN_KEEP[fi] + 1; // +1 for label column
            var sum = 0;
            for (var i = 0; i < n; i++) sum += KNN_TRAINING[i][idx];
            KNN_MEAN[fi] = sum / n;
            var sumSq = 0;
            for (var i = 0; i < n; i++) {
                var d = KNN_TRAINING[i][idx] - KNN_MEAN[fi];
                sumSq += d * d;
            }
            KNN_STDDEV[fi] = Math.max(0.05, Math.sqrt(sumSq / n));
        }
        KNN_STD_DATA = [];
        for (var i = 0; i < n; i++) {
            var row = new Array(nf);
            for (var fi = 0; fi < nf; fi++) {
                row[fi] = (KNN_TRAINING[i][KNN_KEEP[fi] + 1] - KNN_MEAN[fi]) / KNN_STDDEV[fi];
            }
            KNN_STD_DATA.push({ label: KNN_LABELS[KNN_TRAINING[i][0]], vec: row });
        }
    })();

    /**
     * Centroid-first hybrid classifier with physics overrides.
     *
     * Strategy: Use nearest-centroid (trained on 47 XSPOC wells) as the primary
     * classifier, then apply physics-based overrides ONLY for unambiguous cases
     * where published criteria give a definitive answer.
     *
     * Physics overrides (from Echometer TechNotes, Downhole Diagnostic,
     * SPE-173964, McCoy/Rowlan/Podio SWPSC 2015):
     *   - Rod part: area < 0.20, near-flat card → override to rod_part (0.95)
     *   - Gas lock: area < 0.15 → override to gas_lock (0.90)
     *   - Full pump: area > 0.78, flat top > 0.68, flat bottom > 0.60,
     *     AND sharp A-B (ab > 0.30) → override to full_pump (0.90)
     *     Physical basis: liquid is incompressible → sharp corners. If A-B is
     *     rounded, gas is present and it's NOT full pump.
     *   - Gas interference VETO: if ab > 0.40, the A-B transition is too sharp
     *     for gas. Published: "gas compresses before valves open → gradual A-B."
     *     Sharp A-B = liquid only = NOT gas interference.
     *
     * @param {Object} features - From extractFeatures()
     * @returns {Array} [{pattern, confidence, physicsRule, matchDetails}, ...]
     */
    function diagnose(features) {
        if (!features || features.error) return [];

        var f = features;

        // ── Step 1: kNN classifier (primary) + centroid (secondary reference) ──
        var fNames = ['areaRatio', 'flatTop', 'flatBottom', 'fluidPoundIdx',
                      'svTransition', 'tvTransition', 'cdSharpness', 'abSharpness',
                      'dnLoadElev', 'upDropPt', 'maxDropLoc', 'dnConvexity', 'earlyDnLoad',
                      'dsSmooth'];
        var fVec = [];
        for (var fi = 0; fi < fNames.length; fi++) {
            var val = f[fNames[fi]];
            if (val === undefined || val === null || isNaN(val)) return [];
            fVec.push(val);
        }

        // Primary: kNN (k=3 distance-weighted, 12 features, 70% LOO-CV)
        var knnResult = classifyKNN(fVec);

        // Secondary: Centroid distance for reference and L2 sub-classification
        var centroidResults = [];
        var sumExp = 0;
        for (var cid in CENTROIDS) {
            if (!CENTROIDS.hasOwnProperty(cid)) continue;
            var cent = CENTROIDS[cid];
            var dist = 0;
            var cLen = Math.min(fVec.length, cent.mean.length); // centroids are 13-feature
            for (var i = 0; i < cLen; i++) {
                var std = Math.max(cent.std[i], 0.05);
                var d = (fVec[i] - cent.mean[i]) / std;
                dist += d * d;
            }
            dist = Math.sqrt(dist);
            var bonus = Math.log(Math.max(cent.n, 1) + 1) * 0.05;
            var score = -dist + bonus;
            var expScore = Math.exp(score);
            sumExp += expScore;
            centroidResults.push({ id: cid, dist: dist, score: score, expScore: expScore });
        }
        for (var i = 0; i < centroidResults.length; i++) {
            centroidResults[i].confidence = sumExp > 0 ? centroidResults[i].expScore / sumExp : 0;
        }
        centroidResults.sort(function (a, b) { return b.confidence - a.confidence; });

        // Merge kNN result into centroid results ordering:
        // kNN primary goes first, then centroid alternatives
        var knnPrimary = { id: knnResult.label, dist: 0, confidence: knnResult.confidence };
        var mergedResults = [knnPrimary];
        for (var i = 0; i < centroidResults.length; i++) {
            if (centroidResults[i].id !== knnResult.label) {
                mergedResults.push(centroidResults[i]);
            }
        }

        // ── Step 2: Gas interference veto ──
        // Physics overrides removed (v2) — kNN with dsSmooth handles all L1
        // classes better without overrides (70% vs 62% with overrides).
        // Only gas interference veto retained: sharp A-B rules out gas.
        var ar = f.areaRatio, ft = f.flatTop, fb = f.flatBottom;
        var ab = f.abSharpness, cd = f.cdSharpness, dnE = f.dnLoadElev;
        var maxDropLoc = f.maxDropLoc || 0, earlyDn = f.earlyDnLoad || 0;
        var override = null;

        // Gas interference VETO — sharp A-B rules out gas
        // Published (Downhole Diagnostic, EngineerFix, Echometer): "Gas acts as
        // a cushion, resulting in sloped transitions." If A-B is sharp, liquid
        // is moving without gas compression → NOT gas interference.
        var gasVeto = (ab > 0.40);

        // ── Step 3: Build final results — kNN primary + centroid alternatives ──
        var results = [];

        {
            for (var i = 0; i < Math.min(3, mergedResults.length); i++) {
                var cid = mergedResults[i].id;

                // Apply gas interference veto
                if (cid === 'gas_interference' && gasVeto) {
                    // Skip gas interference, promote next result
                    continue;
                }

                var pattern = null;
                for (var p = 0; p < PATTERNS.length; p++) {
                    if (PATTERNS[p].id === cid) { pattern = PATTERNS[p]; break; }
                }
                if (!pattern) continue;

                var conf = Math.round(mergedResults[i].confidence * 100) / 100;
                var reason = i === 0 ? 'kNN match (k=3, ' + (conf * 100).toFixed(0) + '% vote weight).'
                                     : 'Centroid alternative (distance=' + (mergedResults[i].dist || 0).toFixed(1) + ').';

                // Build data-rich physics reasoning for each condition
                var lr = f._loadRange ? Math.round(f._loadRange) : '?';
                var pr = f._posRange ? f._posRange.toFixed(1) : '?';
                if (cid === 'under_filled') {
                    reason = 'Incomplete fillage: card area ' + (f.areaRatio * 100).toFixed(0) + '% of ideal. ';
                    reason += 'Load range ' + lr + ' lbs over ' + pr + ' in stroke. ';
                    // Use new features for better discrimination
                    if (f.maxDropLoc > 0.25 && f.earlyDnLoad > 0.45) {
                        reason += 'Max load drop at ' + (f.maxDropLoc * 100).toFixed(0) + '% into downstroke with high early DN load (' + (f.earlyDnLoad * 100).toFixed(0) + '%) — gas compressing before plunger hits liquid. Likely FLUID POUND. ';
                    } else if (ab < 0.25 && cd < 0.30) {
                        reason += 'Both corners rounded (A-B=' + ab.toFixed(2) + ', C-D=' + cd.toFixed(2) + ') — suggests GAS INTERFERENCE (banana shape). ';
                    } else if (f.maxDropLoc < 0.20 && f.earlyDnLoad < 0.45) {
                        reason += 'Load drops early in downstroke (at ' + (f.maxDropLoc * 100).toFixed(0) + '%) with normal early DN load — INCOMPLETE FILLAGE without severe gas or impact. ';
                    } else {
                        reason += 'C-D sharpness=' + cd.toFixed(2) + ', drop location=' + (f.maxDropLoc * 100).toFixed(0) + '%. ';
                    }
                    reason += 'Take fluid level shot to confirm: fluid at pump = fluid pound, above pump = gas.';
                } else if (cid === 'pump_issue') {
                    reason = 'Card area ' + (f.areaRatio * 100).toFixed(0) + '% of ideal. ';
                    if (f.flatTop > 0.65 && f.flatBottom < 0.40) {
                        reason += 'Asymmetric: flat upstroke (' + f.flatTop.toFixed(2) + ') but irregular downstroke (' + f.flatBottom.toFixed(2) + '). Possible bent barrel or sticking plunger.';
                    } else if (f.flatTop > 0.50 && f.flatBottom > 0.40) {
                        reason += 'Retains rectangular shape but reduced efficiency. Possible worn pump barrel — check for sand production.';
                    } else {
                        reason += 'Partial fillage or mechanical issue. Compare with historical cards to determine if progressive (wear) or sudden (bent/stuck).';
                    }
                } else if (cid === 'tv_leak') {
                    reason = 'Upstroke load declining: slope=' + f.upstrokeSlope.toFixed(2) + ', flat top=' + (f.flatTop * 100).toFixed(0) + '%. ';
                    reason += 'Fluid leaking past traveling valve during upstroke — load falls as plunger rises. ';
                    reason += '(Published: TV leak = upper corners rounded, load drops progressively.)';
                } else if (cid === 'sv_leak') {
                    reason = 'Downstroke load elevated: mid-stroke at ' + (dnE * 100).toFixed(0) + '% of range (normal <15%). ';
                    reason += 'Fluid leaking back through standing valve during downstroke. ';
                    reason += '(Published: SV leak = downstroke load higher than normal, bottom corners rounded.)';
                } else if (cid === 'full_pump') {
                    reason = 'Rectangular card: area ' + (f.areaRatio * 100).toFixed(0) + '%, flat top ' + (f.flatTop * 100).toFixed(0) + '%, flat bottom ' + (f.flatBottom * 100).toFixed(0) + '%. ';
                    reason += 'Load range ' + lr + ' lbs. Pump filling completely each stroke. ';
                    reason += '(Published: ideal pump card approaches perfect rectangle with vertical transitions.)';
                } else if (cid === 'rod_part') {
                    reason = 'Card collapsed to ' + (f.areaRatio * 100).toFixed(0) + '% area with minimal load variation (' + lr + ' lbs). ';
                    reason += 'Rod string parted — surface carries only weight above break. No pumping action at pump.';
                }

                results.push({
                    pattern: pattern,
                    confidence: conf,
                    physicsRule: reason,
                    matchDetails: {},
                });
            }
        }

        results.sort(function (a, b) { return b.confidence - a.confidence; });

        // ── Level 2: Sub-classify merged groups ──
        // If primary is "under_filled" or "pump_issue", find the best L2 sub-type
        // and add it as secondary diagnosis with physics reasoning.
        if (results.length > 0) {
            var primaryId = results[0].pattern.id;
            if (primaryId === 'under_filled' || primaryId === 'pump_issue') {
                var bestSub = null, bestSubScore = -Infinity;
                for (var sid in L2_CENTROIDS) {
                    if (!L2_CENTROIDS.hasOwnProperty(sid)) continue;
                    if (L2_CENTROIDS[sid].group !== primaryId) continue;
                    var sc = L2_CENTROIDS[sid];
                    var sDist = 0;
                    var l2Len = Math.min(fVec.length, sc.mean.length); // L2 centroids are 13-feature
                    for (var i = 0; i < l2Len; i++) {
                        var sStd = Math.max(sc.std[i], 0.05);
                        var sD = (fVec[i] - sc.mean[i]) / sStd;
                        sDist += sD * sD;
                    }
                    sDist = Math.sqrt(sDist);
                    if (-sDist > bestSubScore) {
                        bestSubScore = -sDist;
                        bestSub = sid;
                    }
                }
                if (bestSub) {
                    var subPattern = null;
                    for (var p = 0; p < PATTERNS.length; p++) {
                        if (PATTERNS[p].id === bestSub) { subPattern = PATTERNS[p]; break; }
                    }
                    if (subPattern) {
                        var subReason = 'Sub-classification within ' + results[0].pattern.name + '.';
                        if (bestSub === 'gas_interference') {
                            subReason = 'C-D sharpness=' + cd.toFixed(2) + ', A-B sharpness=' + ab.toFixed(2) + '. If both rounded → gas interference. Confirm with fluid level shot.';
                        } else if (bestSub === 'fluid_pound') {
                            subReason = 'Area ' + (f.areaRatio * 100).toFixed(0) + '% of ideal. ';
                            // Impact indicators
                            if (maxDropLoc > 0.25) {
                                subReason += 'Max load drop at ' + (maxDropLoc * 100).toFixed(0) + '% into downstroke (mid-stroke impact — plunger hitting liquid). ';
                            } else {
                                subReason += 'Max load drop at ' + (maxDropLoc * 100).toFixed(0) + '% into downstroke (early — less typical of pound). ';
                            }
                            if (earlyDn > 0.50) {
                                subReason += 'High early downstroke load (' + (earlyDn * 100).toFixed(0) + '%) — gas compressing before plunger reaches liquid. ';
                            }
                            if (cd > 0.30) {
                                subReason += 'Sharp C-D transition (' + cd.toFixed(2) + ') — consistent with plunger impact. ';
                            } else {
                                subReason += 'Gradual C-D transition (' + cd.toFixed(2) + ') — more typical of gas interference than pound. ';
                            }
                            subReason += 'Confirm with fluid level shot: fluid at pump intake = pound.';
                        } else if (bestSub === 'incomplete_fillage') {
                            subReason = 'Area ' + (f.areaRatio * 100).toFixed(0) + '% of ideal. ';
                            subReason += 'Early downstroke load ' + (earlyDn * 100).toFixed(0) + '%, max drop at ' + (maxDropLoc * 100).toFixed(0) + '% into downstroke. ';
                            if (cd > 0.40) {
                                subReason += 'Sharp C-D (' + cd.toFixed(2) + ') — valves transferring normally, just not enough fluid entering barrel.';
                            } else {
                                subReason += 'Moderate C-D (' + cd.toFixed(2) + ') — partial fill without strong impact.';
                            }
                        } else if (bestSub === 'worn_pump') {
                            subReason = 'Card retains rectangular shape (flat top ' + (f.flatTop * 100).toFixed(0) + '%, flat bottom ' + (f.flatBottom * 100).toFixed(0) + '%) but reduced area (' + (f.areaRatio * 100).toFixed(0) + '%). Fluid slipping past plunger — progressive efficiency loss. Check for sand production.';
                        } else if (bestSub === 'bent_barrel') {
                            subReason = 'Asymmetric card: flat top ' + (f.flatTop * 100).toFixed(0) + '% but flat bottom only ' + (f.flatBottom * 100).toFixed(0) + '%. ';
                            subReason += 'Possible mechanical interference — plunger binding or barrel deformation. Compare with historical cards for onset timing.';
                        }
                        // Insert as secondary (position 1)
                        results.splice(1, 0, {
                            pattern: subPattern,
                            confidence: Math.round(Math.max(0.20, results[0].confidence * 0.6) * 100) / 100,
                            physicsRule: subReason,
                            matchDetails: {},
                        });
                    }
                }
            }
        }

        // ── Level 3: Independent secondary condition flags ──
        // These can co-exist with ANY primary condition (compound diagnoses).
        // Based on published criteria, checked independently.
        // Only add if not already the primary or L2 diagnosis.
        var existingIds = {};
        for (var i = 0; i < results.length; i++) {
            existingIds[results[i].pattern.id] = true;
        }

        var secondaries = [];

        // Phase shift: card appears rotated from expected orientation
        // (Published: sensor timing or calibration issue, not a pump problem)
        if (f.phaseShift > 0.25) {
            secondaries.push({
                id: 'phase_shift',
                reason: 'Card may be phase-shifted (position encoder timing). Not a pump problem.',
                conf: 0.15 + f.phaseShift * 0.3,
            });
        }

        // Possible SV leak: late downstroke load RISES (fluid leaking back through SV)
        // Published: SV leak = downstroke load higher than normal, rising in late portion
        // Key signature: earlyDnLoad is LOW but load increases toward end of downstroke
        if (!existingIds['sv_leak']) {
            var svEvidence = '';
            var svConf = 0;
            // Check for rising downstroke (late > early in absolute terms)
            if (f.downstrokeSlope > 0.08 && f.earlyDnLoad < 0.35) {
                svConf = 0.25 + f.downstrokeSlope * 0.5;
                svEvidence = 'Possible SV leak: downstroke load rising (slope=' + f.downstrokeSlope.toFixed(2) + '), low early DN load (' + (f.earlyDnLoad * 100).toFixed(0) + '%). Fluid may be leaking back through standing valve.';
            } else if (dnE > 0.20 && f.downstrokeSlope > 0.05) {
                svConf = 0.10 + dnE * 0.3;
                svEvidence = 'Possible SV leak: downstroke load elevated (' + (dnE * 100).toFixed(0) + '% of range), slight rising trend.';
            }
            if (svConf > 0.10) {
                secondaries.push({ id: 'sv_leak', reason: svEvidence, conf: svConf });
            }
        }

        // Possible TV leak: declining upstroke load OR high upstroke convexity
        // (Published: TV leak = upper corners rounded, load falls during upstroke.
        //  Upstroke convexity = load peaks mid-stroke then falls = fluid escaping past TV.)
        // Data: TV leak upConvexity=0.27 vs others=0.07 (strong signal)
        if (!existingIds['tv_leak']) {
            var tvConf = 0;
            var tvReason = '';
            // Check upstroke slope (traditional)
            if (f.upstrokeSlope < -0.12 && f.flatTop < 0.55) {
                tvConf = 0.15 + Math.abs(f.upstrokeSlope) * 0.4;
                tvReason = 'Upstroke load declining (slope=' + f.upstrokeSlope.toFixed(2) + '), flat top only ' + (f.flatTop * 100).toFixed(0) + '%. ';
            }
            // Check downstroke slope (TV leak wells show steeper negative dnSlope)
            if (f.downstrokeSlope < -0.15) {
                tvConf = Math.max(tvConf, 0.12 + Math.abs(f.downstrokeSlope) * 0.3);
                tvReason += 'Downstroke load falling steeply (slope=' + f.downstrokeSlope.toFixed(2) + '). ';
            }
            // Check early downstroke load (TV leak = very low earlyDn, data shows 0.23)
            if (f.earlyDnLoad < 0.28 && f.earlyDnLoad > 0) {
                tvConf = Math.max(tvConf, 0.15);
                tvReason += 'Low early downstroke load (' + (f.earlyDnLoad * 100).toFixed(0) + '%). ';
            }
            if (tvConf > 0.10) {
                tvReason += '(Published: TV leak = fluid leaks past traveling valve during upstroke, upper corners rounded.)';
                secondaries.push({ id: 'tv_leak', reason: 'Possible TV leak: ' + tvReason, conf: tvConf });
            }
        }

        // Worn pump barrel: reduced area but retains rectangular shape
        if (!existingIds['worn_pump'] && f.areaRatio < 0.80 && f.areaRatio > 0.50 &&
            f.flatTop > 0.40 && f.flatBottom > 0.35) {
            secondaries.push({
                id: 'worn_pump',
                reason: 'Possible worn barrel: card area reduced to ' + (f.areaRatio * 100).toFixed(0) + '% but shape retained.',
                conf: 0.15,
            });
        }

        // Bent barrel / sticking plunger: asymmetric card
        if (!existingIds['bent_barrel'] && f.symmetry < 0.45 && f.flatTop > 0.50 && f.flatBottom < 0.40) {
            secondaries.push({
                id: 'bent_barrel',
                reason: 'Possible bent barrel: asymmetric card (symmetry=' + f.symmetry.toFixed(2) + '), flat top but irregular bottom.',
                conf: 0.15,
            });
        }

        // Add secondaries that don't duplicate existing results
        for (var si = 0; si < secondaries.length; si++) {
            var sec = secondaries[si];
            if (existingIds[sec.id]) continue;
            var secPattern = null;
            for (var p = 0; p < PATTERNS.length; p++) {
                if (PATTERNS[p].id === sec.id) { secPattern = PATTERNS[p]; break; }
            }
            if (secPattern) {
                results.push({
                    pattern: secPattern,
                    confidence: Math.round(sec.conf * 100) / 100,
                    physicsRule: sec.reason,
                    matchDetails: {},
                    isSecondary: true,
                });
            }
        }

        return results;
    }

    /**
     * Get a human-readable diagnosis summary.
     *
     * @param {Array} position - Downhole card position
     * @param {Array} load     - Downhole card load
     * @param {Object} rodModel - Optional rod model
     * @returns {Object} {primary, secondary, features, allMatches}
     */
    function analyzeCard(position, load, rodModel) {
        var features = extractFeatures(position, load, rodModel);
        if (!features) return { primary: null, error: 'Could not extract features' };

        var matches = diagnose(features);

        return {
            primary: matches.length > 0 ? matches[0] : null,
            secondary: matches.length > 1 ? matches[1] : null,
            features: features,
            allMatches: matches,
        };
    }

    // Public API
    return {
        PATTERNS: PATTERNS,
        extractFeatures: extractFeatures,
        diagnose: diagnose,
        analyzeCard: analyzeCard,
        diagnoseSurfaceCard: diagnoseSurfaceCard,
    };
})();
