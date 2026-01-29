import math
import os
import pandas as pd

#####################
##### CONSTANTS #####
#####################
g = 9.81
v = 1e-6
pi = math.pi


class Equations:
    def __init__(self, data):
        self.data = data
        self.K_elbow45 = 0.20
        self.K_elbow90 = 2 * K_elbow45
        self.K_outlet = 0.0 
        self.K_discharge = 1.0
        self.tee_angle = pi / 4


    def rho(self, m, V):
        return m / V


    def pressure_loss(self, di, L, rho, V, f):
        delta_P = f * (L / di) * 0.5 * rho * V**2
        delta_H = delta_P / (rho * g)
        return delta_P, delta_H


    def minor_pressure_loss(self, K, rho, V):
        delta_P = K * 0.5 * rho * V**2
        delta_H = K * V ** 2 / (2 * g)
        return delta_P, delta_H


    def velocity(self, Q, di):
        V = Q / ((pi / 4) * di**2)
        return V


    def reynolds_number(self, V, di):
        return V * di / v


    def friction_factor(self, e, di, Re):
        term = (e / (3.7 * di)) + (5.74 / (Re ** 0.9))
        f = 1 / (0.86 * math.log(term)) ** 2
        return f

    
    def a(self, A_in, A_out):
        return A_in / A_out

    def reducer_K(self, a):
        if a < 1:
            return -0.513 * a + 0.51 
        else:
            return (a - 1)**2 


    def q(self, Q_s, Q):
        return Q_s / Q

    def tee_main_K(self, a, q, theta, v):
        if a > 0.35:
            K_st = 0.5 
        else:
            K_st = 0.8 * q

        K = (1 - (1 - q)**2 - (1.4 - q) * q**2 * math.sin(theta)) - (K_st * (2 / v) * math.cos(theta))
        return K

    
    def tee_side_K(self, a, q, theta):
        if a > 0.35:
            if q > 0.4:
                B = 0.55
            else:
                B = 0.9 * (1 - q)
        else:
            B = 1

        K = B * (1 + (q / a)**2 - 2 * (1 - q)**2 - (2 / a) * q**2 * math.cos(theta))
        return K

